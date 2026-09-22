/**
 * Time warp for the game page: runs the page's clock k times faster.
 *
 * The game measures time three ways: setTimeout/setInterval (fire, income,
 * events), jQuery animations timed with `new Date()` (button cooldowns), and
 * Date.now() deltas (spaceflight). Warping all of them together keeps every
 * system in step, so a bot run at 20x plays the same game as one at 1x.
 *
 * The factor is read from sessionStorage 'designer.warp' at load (sessionStorage
 * survives the game's own localStorage.clear() on restart) and can be changed
 * live with window.__timewarp.set(k).
 */
(function () {
  'use strict';

  var RealDate = window.Date;
  var realNow = RealDate.now.bind(RealDate);
  var realSetTimeout = window.setTimeout.bind(window);
  var realSetInterval = window.setInterval.bind(window);

  var factor = 1;
  var anchorReal = realNow();
  var anchorVirtual = anchorReal;

  function now() {
    return anchorVirtual + (realNow() - anchorReal) * factor;
  }

  function set(k) {
    k = Number(k);
    if (!(k > 0) || !isFinite(k)) return factor;
    anchorVirtual = now();
    anchorReal = realNow();
    factor = k;
    try { sessionStorage.setItem('designer.warp', String(k)); } catch (e) { /* ignore */ }
    return factor;
  }

  function WarpDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!(this instanceof WarpDate)) return new RealDate(now()).toString();
    if (args.length === 0) return new RealDate(now());
    return new (Function.prototype.bind.apply(RealDate, [null].concat(args)))();
  }
  WarpDate.prototype = RealDate.prototype;
  WarpDate.now = now;
  WarpDate.parse = RealDate.parse;
  WarpDate.UTC = RealDate.UTC;
  window.Date = WarpDate;

  window.setTimeout = function (fn, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    return realSetTimeout.apply(null, [fn, (Number(delay) || 0) / factor].concat(args));
  };
  window.setInterval = function (fn, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    return realSetInterval.apply(null, [fn, (Number(delay) || 0) / factor].concat(args));
  };

  try { set(sessionStorage.getItem('designer.warp') || 1); } catch (e) { /* ignore */ }

  window.__timewarp = {
    set: set,
    get: function () { return factor; },
    now: now,
    realNow: realNow
  };
})();
