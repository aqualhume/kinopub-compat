/* Loaded before site scripts. Syntax intentionally remains ES5 for old Safari. */
(function () {
  'use strict';
  if (!Object.fromEntries) Object.fromEntries = function (entries) {
    var out = {}; entries.forEach(function (entry) { out[entry[0]] = entry[1]; }); return out;
  };
  if (!String.prototype.replaceAll) String.prototype.replaceAll = function (search, replacement) {
    return search instanceof RegExp ? this.replace(search, replacement) : this.split(search).join(replacement);
  };
  if (!Array.prototype.flat) Array.prototype.flat = function (depth) {
    depth = depth === undefined ? 1 : Number(depth);
    return this.reduce(function (out, item) { return out.concat(Array.isArray(item) && depth > 0 ? item.flat(depth - 1) : item); }, []);
  };
  window.lucide = window.lucide || { createIcons: function () {} };
}());
