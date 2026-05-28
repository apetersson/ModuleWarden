/**
 * lodash-extra v1.0.0
 * Thin wrapper around lodash providing additional convenience methods.
 * No dangerous capabilities.
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
