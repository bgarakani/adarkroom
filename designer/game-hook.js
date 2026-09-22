/**
 * Designer hook, injected into the game page by designer/server.js after every
 * game script has parsed and before Engine.init runs on DOM ready.
 *
 * 1. Walks the game's module globals and records every numeric parameter with
 *    its default value (the catalog the panel renders).
 * 2. Applies window.__DESIGNER_OVERRIDES on top.
 *
 * Paths are "/"-joined keys from a global, e.g. "Room/_STOKE_COOLDOWN" or
 * "Events/Encounters/0/scenes/start/loot/fur/chance". Two segment forms are
 * special because the value is not a plain property:
 *   .../cost()/<resource>/base|perOwned  a linear cost function, base + perOwned * owned
 *   .../nextScene/→<scene>               the roll threshold that leads to <scene>
 */
(function () {
  'use strict';

  var ROOTS = ['Room', 'Outside', 'World', 'Path', 'Ship', 'Space', 'Fabricator', 'Events'];

  // Keys that hold runtime state, UI plumbing or geometry rather than design values.
  var SKIP_KEYS = {
    button: 1, options: 1, panel: 1, tab: 1, audio: 1, EventPool: 1, eventStack: 1,
    activeScene: 1, TILE: 1, VILLAGE_POS: 1, NORTH: 1, SOUTH: 1, EAST: 1, WEST: 1,
    _STORES_OFFSET: 1, FireEnum: 1, TempEnum: 1
  };
  var SKIP_PATHS = {
    'Space/hull': 1, 'Space/shipX': 1, 'Space/shipY': 1, 'Space/altitude': 1,
    'Space/lastMove': 1, 'Space/done': 1
  };

  var CHARACTER_KEYS = ['title', 'enemyName', 'name'];
  var defaults = [];
  var errors = [];
  var originalCosts = new Map(); // owner object -> original cost function

  function fail(msg) {
    if (errors.indexOf(msg) === -1) errors.push(msg);
  }

  // Fabricator is a top-level const, which is global but not a window property.
  // Only names in ROOTS reach the Function constructor.
  function root(name) {
    if (ROOTS.indexOf(name) === -1) return undefined;
    return Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined;')();
  }

  function isPlain(v) {
    if (v === null || typeof v !== 'object') return false;
    if (Array.isArray(v)) return true;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }

  // Cost functions read the owned count through $SM.get; every cost in the game
  // is linear in it, so two probes recover base and per-owned step.
  function probeCost(fn) {
    var realGet = $SM.get;
    try {
      $SM.get = function () { return 0; };
      var c0 = fn();
      $SM.get = function () { return 1; };
      var c1 = fn();
      return { c0: c0 || {}, c1: c1 || {} };
    } finally {
      $SM.get = realGet;
    }
  }

  function labelFor(v) {
    for (var i = 0; i < CHARACTER_KEYS.length; i++) {
      if (typeof v[CHARACTER_KEYS[i]] === 'string') return v[CHARACTER_KEYS[i]];
    }
    return null;
  }

  function walk(obj, path, names, seen) {
    if (seen.has(obj)) return; // shared objects (e.g. executioner loot) are listed once
    seen.add(obj);
    Object.keys(obj).forEach(function (key) {
      if (SKIP_KEYS[key]) return;
      var p = path.concat(key);
      if (SKIP_PATHS[p.join('/')]) return;
      var v = obj[key];
      var n = names.concat(null);
      if (typeof v === 'number' && isFinite(v)) {
        defaults.push({ path: p.join('/'), names: n, value: v });
      } else if (typeof v === 'function' && key === 'cost') {
        var probe;
        try { probe = probeCost(v); } catch (e) { return; }
        Object.keys(probe.c0).forEach(function (res) {
          var base = probe.c0[res], step = (probe.c1[res] || 0) - base;
          if (typeof base !== 'number') return;
          var cp = p.slice(0, -1).concat('cost()', res);
          var cn = names.concat(null, null);
          defaults.push({ path: cp.concat('base').join('/'), names: cn.concat(null), value: base, kind: 'cost' });
          defaults.push({ path: cp.concat('perOwned').join('/'), names: cn.concat(null), value: step, kind: 'costStep' });
        });
      } else if (key === 'nextScene' && isPlain(v)) {
        Object.keys(v).forEach(function (threshold) {
          defaults.push({
            path: p.concat('→' + v[threshold]).join('/'), names: n.concat(null),
            value: parseFloat(threshold), kind: 'threshold'
          });
        });
      } else if (isPlain(v)) {
        var label = labelFor(v);
        walk(v, p, label ? names.concat(label) : n, seen);
      }
    });
  }

  function buildCatalog() {
    // TILE_PROBS and LANDMARKS are filled inside World.init; fill them now so
    // they are listed from the first page load. World.init refills them.
    try { World.defineWorld(); } catch (e) { fail('World.defineWorld: ' + e.message); }
    var seen = new Set();
    ROOTS.forEach(function (name) {
      if (root(name)) walk(root(name), [name], [null], seen);
    });
  }

  function resolve(segs) {
    var obj = root(segs[0]);
    for (var i = 1; i < segs.length; i++) {
      if (obj === null || typeof obj !== 'object') return undefined;
      obj = obj[segs[i]];
    }
    return obj;
  }

  function ownedCount(owner, name) {
    if (owner.type === 'building') return $SM.get('game.buildings["' + name + '"]', true);
    return $SM.get('stores["' + name + '"]', true);
  }

  function installCost(ownerPath, spec) {
    var segs = ownerPath.split('/');
    var owner = resolve(segs);
    if (!owner || typeof owner.cost !== 'function') {
      fail('no cost function at ' + ownerPath);
      return;
    }
    if (!originalCosts.has(owner)) originalCosts.set(owner, owner.cost);
    var original = originalCosts.get(owner);
    var name = segs[segs.length - 1];
    owner.cost = function () {
      var out = Object.assign({}, original.apply(this, arguments));
      var n = Object.keys(spec).some(function (r) { return spec[r].perOwned; }) ? ownedCount(owner, name) : 0;
      Object.keys(spec).forEach(function (res) {
        var amount = spec[res].base + spec[res].perOwned * n;
        if (amount > 0) out[res] = amount; else delete out[res];
      });
      return out;
    };
  }

  function setThreshold(segs, value) {
    var map = resolve(segs.slice(0, -1));
    var target = segs[segs.length - 1].slice(1);
    if (!isPlain(map)) { fail('no nextScene at ' + segs.join('/')); return; }
    var current = Object.keys(map).filter(function (k) { return map[k] === target; })[0];
    if (current === undefined) { fail('no scene ' + target + ' at ' + segs.join('/')); return; }
    if (String(value) === current) return;
    if (map[String(value)] !== undefined) { fail('duplicate threshold ' + value + ' at ' + segs.join('/')); return; }
    delete map[current];
    map[String(value)] = target;
  }

  var defaultByPath = null;
  function defaultValue(path) {
    if (!defaultByPath) {
      defaultByPath = {};
      defaults.forEach(function (d) { defaultByPath[d.path] = d.value; });
    }
    return defaultByPath[path];
  }

  // Idempotent: safe to call again whenever the game resets a value.
  function applyAll() {
    var overrides = window.__DESIGNER_OVERRIDES || {};
    var costs = {};
    Object.keys(overrides).forEach(function (path) {
      var value = overrides[path];
      var segs = path.split('/');
      var ci = segs.indexOf('cost()');
      if (ci !== -1) {
        var owner = segs.slice(0, ci).join('/'), res = segs[ci + 1];
        costs[owner] = costs[owner] || {};
        costs[owner][res] = costs[owner][res] || {};
        costs[owner][res][segs[ci + 2]] = value;
        return;
      }
      var last = segs[segs.length - 1];
      if (last.charAt(0) === '→' && segs[segs.length - 2] === 'nextScene') {
        setThreshold(segs, value);
        return;
      }
      var parent = resolve(segs.slice(0, -1));
      if (parent === null || typeof parent !== 'object' || typeof parent[last] !== 'number') {
        fail('unknown parameter ' + path);
        return;
      }
      parent[last] = value;
    });
    Object.keys(costs).forEach(function (owner) {
      var spec = costs[owner];
      Object.keys(spec).forEach(function (res) {
        var prefix = owner + '/cost()/' + res + '/';
        if (spec[res].base === undefined) spec[res].base = defaultValue(prefix + 'base') || 0;
        if (spec[res].perOwned === undefined) spec[res].perOwned = defaultValue(prefix + 'perOwned') || 0;
      });
      installCost(owner, spec);
    });
  }

  // Re-apply after any step that rewrites design values: World.defineWorld runs
  // inside World.init just before the map is generated; Room/Outside init swap in
  // debug timings when Engine._debug is on.
  function reapplyAfter(obj, fnName) {
    var original = obj[fnName];
    obj[fnName] = function () {
      var result = original.apply(this, arguments);
      applyAll();
      return result;
    };
  }

  buildCatalog();
  applyAll();
  reapplyAfter(World, 'defineWorld');
  ROOTS.forEach(function (name) {
    var mod = root(name);
    if (mod && typeof mod.init === 'function') reapplyAfter(mod, 'init');
  });

  window.__designer = {
    defaults: defaults,
    overrides: window.__DESIGNER_OVERRIDES || {},
    errors: errors
  };
  if (errors.length) console.warn('[designer]', errors);
})();
