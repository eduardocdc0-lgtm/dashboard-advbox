const AdvBoxClient = require('./advbox-client');

module.exports = new AdvBoxClient(process.env.ADVBOX_TOKEN || '');
