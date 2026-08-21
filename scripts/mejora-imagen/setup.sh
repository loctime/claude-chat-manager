#!/bin/bash
echo "Instalando dependencias para mejora-imagen..."
python3 -m pip install opencv-python-headless --break-system-packages -q
echo "Verificando instalación..."
python3 -c "import cv2; print('OpenCV OK:', cv2.__version__)"
echo "Listo."
