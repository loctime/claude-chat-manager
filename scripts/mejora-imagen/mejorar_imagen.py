"""
Mejora de imágenes de documentos escaneados / fotos de remitos, facturas, etc.
Uso: python3 mejorar_imagen.py "ruta/imagen.jpg"
Genera: imagen_recortada.jpg (documento detectado, enderezado y recortado — a color)
        imagen_limpia.jpg (documento limpio en blanco y negro)
        imagen_limpia_2x.jpg (versión ampliada para OCR)
"""

import sys
import os
import cv2
import numpy as np


def _order_points(pts: np.ndarray) -> np.ndarray:
    """Ordena 4 puntos como [top-left, top-right, bottom-right, bottom-left]."""
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]  # top-left: menor x+y
    rect[2] = pts[np.argmax(s)]  # bottom-right: mayor x+y
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]  # top-right: menor y-x
    rect[3] = pts[np.argmax(diff)]  # bottom-left: mayor y-x
    return rect


def _four_point_transform(image: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Corrige perspectiva: recorta y endereza el cuadrilátero `pts` a un rectángulo."""
    rect = _order_points(pts)
    (tl, tr, br, bl) = rect

    width_a = np.linalg.norm(br - bl)
    width_b = np.linalg.norm(tr - tl)
    max_width = max(int(width_a), int(width_b))

    height_a = np.linalg.norm(tr - br)
    height_b = np.linalg.norm(tl - bl)
    max_height = max(int(height_a), int(height_b))

    dst = np.array([
        [0, 0],
        [max_width - 1, 0],
        [max_width - 1, max_height - 1],
        [0, max_height - 1],
    ], dtype="float32")

    m = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(image, m, (max_width, max_height))


def _mayor_contorno(mask: np.ndarray):
    """
    Contorno más grande de una máscara binaria (255 = documento), o None si
    no hay ninguno del tamaño razonable de un documento (ej. ruido suelto,
    menos del 20% del cuadro).
    """
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    c = max(contours, key=cv2.contourArea)
    if cv2.contourArea(c) < 0.2 * (mask.shape[0] * mask.shape[1]):
        return None
    return c


def _quad_desde_contorno(c: np.ndarray) -> np.ndarray:
    """Aproxima un contorno a un cuadrilátero (4 esquinas)."""
    peri = cv2.arcLength(c, True)
    for eps in (0.02, 0.03, 0.05, 0.08):
        approx = cv2.approxPolyDP(c, eps * peri, True)
        if len(approx) == 4:
            return approx.reshape(4, 2).astype("float32")

    # Esquina doblada/curva u otro defecto que impide un cuadrilátero limpio
    # con approxPolyDP: el rectángulo rotado de mínima área es una
    # aproximación razonable — sigue siendo mejor que no recortar nada.
    box = cv2.boxPoints(cv2.minAreaRect(c))
    return box.astype("float32")


def _rectangularidad(c: np.ndarray) -> float:
    """
    Qué tan parecido a un rectángulo es el contorno: área real contra área
    del rectángulo rotado de mínima área que lo contiene (1.0 = calza
    perfecto). Un documento bien segmentado da un valor alto (>0.8); un blob
    irregular da uno bajo — ej. el papel fusionado, por un reflejo de luz
    puntual, con un pedazo de la mesa de al lado: el contorno sigue siendo
    "grande" pero el rectángulo que lo encierra es mucho más grande que el
    área real del blob, porque el apéndice de mesa cuelga para un costado.
    """
    (_, (rw, rh), _) = cv2.minAreaRect(c)
    rect_area = rw * rh
    return cv2.contourArea(c) / rect_area if rect_area > 0 else 0.0


def _detectar_por_grabcut(resized: np.ndarray):
    """
    Fallback cuando la segmentación por saturación no da un contorno
    confiable (ver detectar_documento). Asume el documento razonablemente
    centrado en la foto — con margen alrededor, como se sostiene naturalmente
    una foto de celular — e inicializa GrabCut con un rectángulo interior.
    GrabCut modela los colores de primer plano y fondo por separado (dos
    mezclas de gaussianas + corte de grafo), así que no depende de un único
    umbral global: separa el documento aunque su rango de color se solape
    parcialmente con el del fondo, mientras la textura/iluminación alrededor
    del rectángulo inicial sea mayormente fondo.
    """
    rh, rw = resized.shape[:2]
    mask = np.zeros((rh, rw), np.uint8)
    bgd_model = np.zeros((1, 65), np.float64)
    fgd_model = np.zeros((1, 65), np.float64)
    # Margen chico (3%, no 8-10% como suele usarse): un documento real de
    # papel a menudo llega casi al borde del cuadro (la factura de gas del
    # hallazgo de abajo llegaba al 90% del ancho) — con margen grande,
    # GrabCut descarta esa franja como fondo "seguro" de entrada y ese borde
    # del documento queda cortado para siempre en el resultado, sin
    # posibilidad de recuperarlo después.
    mx, my = int(rw * 0.03), int(rh * 0.03)
    rect = (mx, my, rw - 2 * mx, rh - 2 * my)
    try:
        cv2.grabCut(resized, mask, rect, bgd_model, fgd_model, 5, cv2.GC_INIT_WITH_RECT)
    except cv2.error:
        return None

    fg = np.where((mask == 2) | (mask == 0), 0, 255).astype("uint8")
    cobertura = (fg == 255).mean()
    if cobertura < 0.05 or cobertura > 0.92:
        return None  # tampoco separó nada útil — no insistir con un resultado peor

    kernel = np.ones((9, 9), np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, kernel, iterations=2)
    c = _mayor_contorno(fg)
    return _quad_desde_contorno(c) if c is not None else None


def detectar_documento(img: np.ndarray):
    """
    Busca el contorno del documento. Devuelve las 4 esquinas en las
    coordenadas de la imagen ORIGINAL, o None si no encuentra nada razonable
    (ej. la foto ya viene recortada, o el fondo no tiene contraste).

    Segmentación por saturación (HSV), no Canny + contornos: un papel es casi
    acromático (S bajo) contra casi cualquier fondo real (mesa de madera,
    mano, tela, mármol), que tiene más saturación. Encontrado con una foto
    real (09/2026): Canny fallaba porque un reflejo de luz sobre la mesa
    cerca de un borde del papel bajaba el contraste local ahí y rompía el
    lazo cerrado de edges — findContours nunca veía un contorno grande, solo
    fragmentos internos (el logo, el texto). La segmentación por color no
    depende de que el borde forme un lazo continuo: es un blob, no un trazo.
    """
    h, w = img.shape[:2]
    target_h = 800
    ratio = h / float(target_h) if h > target_h else 1.0
    resized = cv2.resize(img, (int(w / ratio), int(h / ratio))) if ratio != 1.0 else img.copy()

    hsv = cv2.cvtColor(resized, cv2.COLOR_BGR2HSV)
    saturacion = hsv[:, :, 1]
    _, mask = cv2.threshold(saturacion, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    # Cerrar huecos internos (letras/logo oscuros del propio documento
    # aparecen como saturación distinta) y sacar ruido suelto del fondo.
    kernel = np.ones((9, 9), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=3)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

    cobertura = (mask == 255).mean()
    c = _mayor_contorno(mask)
    extent = _rectangularidad(c) if c is not None else 0.0
    pts = _quad_desde_contorno(c) if c is not None else None

    # Dos hallazgos reales (19/08/2026) donde la segmentación por saturación
    # "detecta" algo pero el resultado es peor que no recortar nada:
    #
    # 1. Fondo mayormente acromático (mantel claro, mantel a cuadros
    #    blanco/negro): la saturación del fondo cae tan baja como la del
    #    propio documento y el umbral global de Otsu no separa nada — la
    #    máscara "se come" casi todo el cuadro (cobertura > 0.85).
    # 2. Reflejo de luz puntual sobre la mesa, pegado al borde del papel
    #    (factura de gas sobre madera): el reflejo tiene tan poca saturación
    #    como el papel y actúa de "puente" — el blob fusiona el documento
    #    con un pedazo de mesa colgando para un costado. La cobertura total
    #    puede seguir siendo baja (~60%) pero el contorno ya no es
    #    rectangular (extent bajo) y el cuadrilátero ajustado sale torcido.
    #
    # En cualquiera de los dos casos vale más un método que compare colores
    # de a dos regiones (GrabCut) que insistir con un único corte global.
    if pts is None or cobertura > 0.85 or extent < 0.75:
        pts_gc = _detectar_por_grabcut(resized)
        if pts_gc is not None:
            pts = pts_gc

    if pts is None:
        return None
    return pts * ratio


def mejorar_documento(src: str, output_dir: str = None, verbose: bool = True) -> dict:
    """
    Recibe una imagen (jpg/png/jpeg) de un documento con tinte, manchas,
    perspectiva torcida o baja calidad. Devuelve un dict con las rutas de los
    archivos generados y si se pudo detectar y enderezar el documento.
    """
    if not os.path.exists(src):
        raise FileNotFoundError(f"Archivo no encontrado: {src}")

    img = cv2.imread(src)
    if img is None:
        raise ValueError(f"No se pudo leer la imagen: {src}")

    h_orig, w_orig = img.shape[:2]

    # Paso 0: detectar el documento y enderezar la perspectiva (tipo CamScanner).
    # Si no se detecta un cuadrilátero confiable, seguimos con la foto completa
    # tal cual vino — mejor una mejora parcial que un recorte mal hecho.
    detectado = False
    pts = detectar_documento(img)
    if pts is not None:
        try:
            warped = _four_point_transform(img, pts)
            if warped.shape[0] > 10 and warped.shape[1] > 10:
                img = warped
                detectado = True
        except Exception:
            pass

    h, w = img.shape[:2]

    # Determinar carpeta de salida
    if output_dir is None:
        output_dir = os.path.dirname(os.path.abspath(src))
    os.makedirs(output_dir, exist_ok=True)

    base = os.path.splitext(os.path.basename(src))[0]

    # Versión a color, ya recortada/enderezada (si se detectó documento) —
    # sirve para revisar el resultado antes de la limpieza en blanco y negro.
    path_recortada = os.path.join(output_dir, f"{base}_recortada.jpg")
    cv2.imwrite(path_recortada, img, [cv2.IMWRITE_JPEG_QUALITY, 92])

    # Paso 1: canal rojo — elimina tinte azul/verde de papel carbónico
    r = img[:, :, 2]  # BGR: índice 2 = canal rojo

    # Paso 2: normalizar iluminación en vez de umbral adaptivo local.
    # Encontrado con una foto real (09/2026): adaptiveThreshold con blockSize
    # chico (31px) vacía por dentro cualquier trazo grueso que no sea negro
    # puro (ej. un logo gris) — dentro del bloque, el centro del trazo queda
    # por encima del umbral local y solo el borde (donde cambia respecto al
    # fondo) cae del lado "tinta", dejando el trazo como contorno hueco.
    # Estimando el fondo con un blur grande y dividiendo, la imagen queda con
    # iluminación pareja y un único umbral global (Otsu) alcanza — sin ese
    # efecto de "solo contorno" en tintas claras o medias.
    sigma = max(15, min(w, h) // 40)
    fondo = cv2.GaussianBlur(r, (0, 0), sigmaX=sigma)
    normalizada = cv2.divide(r, fondo, scale=255)

    # Paso 3: Otsu sobre la imagen ya normalizada
    _, limpia = cv2.threshold(normalizada, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Guardar imagen limpia 1x
    path_1x = os.path.join(output_dir, f"{base}_limpia.jpg")
    cv2.imwrite(path_1x, limpia, [cv2.IMWRITE_JPEG_QUALITY, 97])

    # Guardar imagen limpia 2x (mejor para OCR)
    limpia_2x = cv2.resize(limpia, (w * 2, h * 2), interpolation=cv2.INTER_LANCZOS4)
    path_2x = os.path.join(output_dir, f"{base}_limpia_2x.jpg")
    cv2.imwrite(path_2x, limpia_2x, [cv2.IMWRITE_JPEG_QUALITY, 97])

    if verbose:
        print(f"Imagen original: {w_orig}x{h_orig}px")
        print(f"Documento detectado y enderezado: {'sí' if detectado else 'no (se usó la foto completa)'}")
        print(f"  → {path_recortada}")
        print(f"  → {path_1x}")
        print(f"  → {path_2x}")

    return {"detectado": detectado, "recortada": path_recortada, "1x": path_1x, "2x": path_2x}


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--json"]
    as_json = "--json" in sys.argv

    if len(args) < 1:
        print("Uso: python3 mejorar_imagen.py 'archivo.jpg' ['carpeta_salida'] [--json]")
        sys.exit(1)

    src = args[0]
    output_dir = args[1] if len(args) > 1 else None

    try:
        resultado = mejorar_documento(src, output_dir, verbose=not as_json)
    except Exception as e:
        if as_json:
            import json
            print(json.dumps({"error": str(e)}))
            sys.exit(1)
        raise

    if as_json:
        import json
        print(json.dumps(resultado))
