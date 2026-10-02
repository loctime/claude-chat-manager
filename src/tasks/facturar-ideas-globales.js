const { crearFlujoFacturacion } = require('./lib/arca-cliente-flow');

// Diego lo llama "Maximia" de palabra, pero la razón social ante ARCA es
// Ideas Globales S.A. (confirmado 29/09/2026 comparando contra la factura
// de implementación de sistema de $600.000, que fue un cobro puntual —
// el monto recurrente mensual es otro, ver abajo).
module.exports = crearFlujoFacturacion({
  nombre: 'Ideas Globales S.A. (Maximia)',
  cuit: '30718725786',
  monto: 500000,
  item: 'Pago del servicio',
});
