/**
 * lodash-extra v2.0.0
 * Thin wrapper around lodash providing additional convenience methods.
 * Now also depends on chalk for color output.
 * No dangerous capabilities - same code as v1.
 */

const lodash = require('lodash');

function mergeObjects(a, b) {
  return lodash.merge({}, a, b);
}

function deepClone(obj) {
  return lodash.cloneDeep(obj);
}

function pickKeys(obj, keys) {
  return lodash.pick(obj, keys);
}

module.exports = { mergeObjects, deepClone, pickKeys };
