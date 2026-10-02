// Flujo compartido de Task "Facturar <cliente>": cliente y monto ya son fijos
// (definidos en el archivo que llama a esta fábrica), así que solo hace
// falta mostrar la vista previa y confirmar. Reusa arca-facturacion
// (certificado, clave privada y cliente WSFE) en vez de duplicar el código
// del web service — ver Desktop/Proyectos/arca-facturacion.
const path = require('path');

const ARCA_DIR = path.join(__dirname, '..', '..', '..', '..', 'arca-facturacion');
const { TIPO_COMPROBANTE, TIPO_DOC, CONDICION_IVA_RECEPTOR, simularOEmitir } =
  require(path.join(ARCA_DIR, 'src', 'comprobantes'));

const PTO_VTA = 2;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function rangoMesActual() {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = hoy.getMonth(); // 0-indexado
  const desde = `${y}${pad2(m + 1)}01`;
  const ultimoDia = new Date(y, m + 1, 0).getDate();
  const hasta = `${y}${pad2(m + 1)}${pad2(ultimoDia)}`;
  return { desde, hasta };
}

function formatearMonto(monto) {
  return monto.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// cliente: { nombre, cuit, monto, item }
function crearFlujoFacturacion(cliente) {
  return {
    run: async ({ state, dryRun }) => {
      const step = state.step;

      // Paso 1: vista previa (cliente y monto ya son fijos, nada que preguntar)
      if (!step) {
        const { desde, hasta } = rangoMesActual();
        const datos = {
          ptoVta: PTO_VTA,
          cbteTipo: TIPO_COMPROBANTE.FACTURA_C,
          concepto: 2, // servicios
          docTipo: TIPO_DOC.CUIT,
          docNro: Number(cliente.cuit),
          condicionIVAReceptorId: CONDICION_IVA_RECEPTOR.RESPONSABLE_INSCRIPTO,
          importeTotal: cliente.monto,
          fechaServicioDesde: desde,
          fechaServicioHasta: hasta,
          fechaVtoPago: hasta,
        };
        const resumen = [
          'Revisá antes de confirmar:',
          '',
          `Cliente: ${cliente.nombre} (CUIT ${cliente.cuit})`,
          `Concepto: ${cliente.item}`,
          `Factura C — Punto de venta ${PTO_VTA}`,
          `Importe: $${formatearMonto(cliente.monto)}`,
          `Período de servicio: ${desde} a ${hasta}`,
          '',
          dryRun
            ? '🧪 Modo prueba: al confirmar se simula, no se manda nada real a ARCA.'
            : '⚠️ Al confirmar se emite de verdad y consume numeración real — no se puede deshacer.',
        ].join('\n');
        return {
          state: { step: 'confirmar', datos },
          ui: { type: 'texto-editable', texto: resumen },
        };
      }

      // Paso 2: emitir (o simular si todavía no está activada)
      if (step === 'confirmar') {
        const det = await simularOEmitir(state.datos, { confirmar: !dryRun });
        const texto = dryRun
          ? '🧪 Simulación hecha. Activá la tarea con "✅ Confirmar y activar" (abajo) para poder emitir de verdad.'
          : [
              '✅ Factura emitida.',
              `CAE: ${det.CAE}`,
              `Vencimiento CAE: ${det.CAEFchVto}`,
              `Número de comprobante: ${det.CbteDesde}`,
            ].join('\n');
        return {
          state: { step: 'resultado' },
          ui: { type: 'texto-editable', texto },
        };
      }

      // Paso 3: cerrar — marca la tarea como hecha
      return { state: {}, ui: { type: 'listo' } };
    },
  };
}

module.exports = { crearFlujoFacturacion };
