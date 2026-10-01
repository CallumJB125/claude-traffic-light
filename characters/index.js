// Node entry: the contract with every built-in character registered.
const Contract = require('./contract.js');
require('./builtin/core.js');
require('./builtin/wave2.js');
require('./builtin/wave3.js');
require('./builtin/starter.js');

module.exports = Contract;
