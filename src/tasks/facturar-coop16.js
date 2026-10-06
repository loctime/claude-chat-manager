const { crearFlujoFacturacion } = require('./lib/arca-cliente-flow');

module.exports = crearFlujoFacturacion({
  nombre: 'Cooperativa 16 de Octubre',
  cuit: '30586994189',
  monto: 700000,
  item: 'Mantenimiento web y contenido de redes',
});
