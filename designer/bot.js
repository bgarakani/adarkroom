/**
 * Autoplay bot for A Dark Room. Rule-based, no AI: every decision comes from
 * the fixed priorities and thresholds below, and every decision is traced with
 * the rule that produced it.
 *
 * The bot plays through the game's own controls (clicking its buttons,
 * World.moveNorth and friends, Space's steering flags), so costs, cooldowns
 * and unlock rules apply exactly as they do for a person.
 *
 * Control surface (used by the designer panel): window.__bot
 *   start({fresh}) stop() step() status() since(seq)
 * Traces stream to the server as NDJSON: designer/traces/<runId>.ndjson
 */
(function () {
  'use strict';

  var TICK_MS = 250;        // decision interval, virtual time
  var SPACE_TICK_MS = 40;   // steering interval in space
  var WORKER_PASS_MS = 20000;
  var SNAPSHOT_MS = 30000;
  var TRIP_REST_MS = 60000; // economy time between expeditions
  var RETURN_MARGIN = 4;    // spare moves kept for the walk home
  var MAX_TRACE = 5000;     // entries kept in memory for the panel
  var SESSION_KEY = 'designer.bot';

  // ---------------------------------------------------------------- strategy tables

  // Buildings and crafts in order. The first unmet entry is the goal; later
  // entries are built meanwhile only if they spend nothing the goal needs.
  var BUILD_PLAN = [
    ['trap', 2], ['cart', 1], ['hut', 2], ['trap', 5], ['lodge', 1], ['hut', 5],
    ['trading post', 1], ['tannery', 1], ['smokehouse', 1], ['trap', 8], ['hut', 8],
    ['torch', 3], ['workshop', 1], ['waterskin', 1], ['rucksack', 1], ['bone spear', 1],
    ['l armour', 1], ['hut', 12], ['steelworks', 1], ['cask', 1], ['wagon', 1],
    ['iron sword', 1], ['i armour', 1], ['hut', 16], ['armoury', 1], ['water tank', 1],
    ['convoy', 1], ['steel sword', 1], ['s armour', 1], ['rifle', 1], ['trap', 10],
    ['hut', 20], ['torch', 10]
  ];

  // Share of the population each job gets before the balancing pass.
  var WORKER_SHARES = {
    'hunter': 0.30, 'trapper': 0.06, 'tanner': 0.08, 'charcutier': 0.08,
    'iron miner': 0.08, 'coal miner': 0.08, 'sulphur miner': 0.05,
    'steelworker': 0.05, 'armourer': 0.03
  };
  var MAINTENANCE_SHARE = 0.2; // a rebuild may spend this share of a resource
  var RUNWAY_TICKS = 30; // a resource may not run dry within this many income ticks

  // Expedition kit. Weapons: the best of each kind; then fixed counts.
  var MELEE = ['energy blade', 'bayonet', 'steel sword', 'iron sword', 'bone spear'];
  var RANGED = ['plasma rifle', 'laser rifle', 'rifle'];
  var KIT = [['medicine', 5], ['hypo', 5], ['bullets', 20], ['energy cell', 15], ['torch', 4], ['bolas', 2], ['grenade', 2]];

  var SHIP_HULL_TARGET = 12;
  var SHIP_THRUSTER_TARGET = 4;

  // Events whose best answer is known; the rest are scored generically.
  var EVENT_RULES = {
    'Sound Available!': ['no'],
    'The Nomad': ['buyCompass', 'goodbye'],
    'Ready to Leave?': ['fly']
  };
  var COST_WEIGHT = {
    'torch': 2, 'cured meat': 1, 'medicine': 3, 'hypo': 3, 'water': 0.5, 'hp': 1,
    'bullets': 0.2, 'energy cell': 0.3, 'fur': 0.01, 'wood': 0.005, 'scales': 0.05,
    'teeth': 0.05, 'alien alloy': 5
  };
  var RETREAT_WORDS = /leave|ignore|turn away|go back|walk away|flee|run|goodbye|linger|move on/i;

  // ---------------------------------------------------------------- run state

  var S = {
    running: false, runId: null, seq: 0, elapsedBefore: 0, loadVirtual: now(),
    trace: [], unsent: [], timer: null, spaceTimer: null, flushTimer: null,
    lastWorkerPass: -Infinity, lastSnapshot: -Infinity, lastTripEnd: -Infinity,
    intent: '', trip: null, landmarkAttempts: {}, choiceCounts: {}, steer: 0, milestones: [], reached: {},
    lastChoice: null, lootWait: null,
    stalled: 0, lastTickVirtual: 0
  };

  function now() { return window.__timewarp ? window.__timewarp.now() : Date.now(); }

  // Trace time is the time the game actually got. A hidden tab is throttled by
  // the browser to roughly one timer wake-up per second, and the warped clock
  // keeps running through it, so those stalls are measured and subtracted.
  function elapsed() { return S.elapsedBefore + (now() - S.loadVirtual) - S.stalled; }

  function accountForStall() {
    var v = now();
    var gap = v - S.lastTickVirtual;
    S.lastTickVirtual = v;
    if (gap > TICK_MS * 8) {
      var lost = gap - TICK_MS;
      S.stalled += lost;
      var warp = window.__timewarp ? window.__timewarp.get() : 1;
      trace('run.stall', { lostGameMs: Math.round(lost), realMs: Math.round(lost / warp), hidden: document.hidden });
    }
  }

  function saveSession() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        running: S.running, runId: S.runId, seq: S.seq, elapsed: elapsed(), stalled: S.stalled,
        lastTripEnd: S.lastTripEnd === -Infinity ? null : S.lastTripEnd - elapsed(),
        landmarkAttempts: S.landmarkAttempts, milestones: S.milestones, reached: S.reached
      }));
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- trace

  function moduleName() {
    var m = Engine.activeModule;
    return m === Room ? 'Room' : m === Outside ? 'Outside' : m === Path ? 'Path' : m === World ? 'World'
      : m === Ship ? 'Ship' : m === Space ? 'Space' : m === Fabricator ? 'Fabricator' : '?';
  }

  function trace(type, data) {
    if (!S.running) return null;
    var entry = Object.assign({ seq: ++S.seq, t: Math.round(elapsed()), type: type, module: moduleName() }, data);
    S.trace.push(entry);
    if (S.trace.length > MAX_TRACE) S.trace.shift();
    S.unsent.push(entry);
    return entry;
  }

  function flush(keepalive) {
    if (!S.unsent.length || !S.runId) return;
    var batch = S.unsent;
    S.unsent = [];
    var body = batch.map(function (e) { return JSON.stringify(e); }).join('\n') + '\n';
    fetch('/api/traces/' + encodeURIComponent(S.runId), {
      method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: body, keepalive: !!keepalive
    }).catch(function () { S.unsent = batch.concat(S.unsent); });
    saveSession();
  }

  function stores() { return Object.assign({}, $SM.get('stores') || {}); }

  function diff(before, after) {
    var d = {};
    Object.keys(Object.assign({}, before, after)).forEach(function (k) {
      var change = (after[k] || 0) - (before[k] || 0);
      if (change) d[k] = Math.round(change * 100) / 100;
    });
    return d;
  }

  // Run fn as one traced action: what, why, and how the stores moved.
  function act(action, target, reason, fn) {
    var before = stores();
    var result = fn();
    var entry = { action: action, target: target, reason: reason };
    var delta = diff(before, stores());
    if (Object.keys(delta).length) entry.delta = delta;
    if (result !== undefined) entry.result = result;
    trace('action', entry);
    S.intent = action + (target ? ' ' + target : '') + ' — ' + reason;
    return result;
  }

  function snapshot(why) {
    trace('snapshot', {
      why: why,
      stores: stores(),
      buildings: Object.assign({}, $SM.get('game.buildings') || {}),
      workers: Object.assign({}, $SM.get('game.workers') || {}),
      population: $SM.get('game.population') || 0,
      fire: $SM.get('game.fire.value'), temperature: $SM.get('game.temperature.value'),
      builder: $SM.get('game.builder.level'),
      perks: Object.keys($SM.get('character.perks') || {}),
      ship: $SM.get('game.spaceShip') ? { hull: $SM.get('game.spaceShip.hull'), thrusters: $SM.get('game.spaceShip.thrusters') } : undefined
    });
    S.lastSnapshot = elapsed();
  }

  function wrap(obj, name, after) {
    var original = obj[name];
    if (typeof original !== 'function') return;
    obj[name] = function () {
      var args = arguments;
      var pre = after.before ? after.before.apply(this, args) : undefined;
      var result = original.apply(this, args);
      try { after.call(this, args, result, pre); } catch (e) { console.warn('[bot trace]', e); }
      return result;
    };
  }

  function worldStatus() {
    return {
      pos: World.curPos ? World.curPos.slice() : null,
      tile: World.state && World.curPos ? World.state.map[World.curPos[0]][World.curPos[1]] : null,
      hp: World.health, maxHp: World.getMaxHealth(), water: World.water,
      meat: Path.outfit ? Path.outfit['cured meat'] || 0 : 0,
      home: World.curPos ? World.getDistance() : null
    };
  }

  function installTraceHooks() {
    wrap(Notifications, 'notify', function (args) {
      if (args[1]) trace('notify', { text: String(args[1]) });
    });
    wrap(Engine, 'event', function (args) {
      if (args[0] === 'progress') {
        S.milestones.push({ t: Math.round(elapsed()), what: args[1] });
        trace('milestone', { what: args[1] });
      }
    });
    wrap(Events, 'startEvent', function (args) {
      var ev = args[0];
      if (!ev) return;
      var at = Engine.activeModule === World && World.curPos ? World.curPos.join(',') : undefined;
      if (at) S.landmarkAttempts[at] = (S.landmarkAttempts[at] || 0) + 1;
      S.choiceCounts = {};
      trace('event.start', { title: ev.title, at: at });
    });
    wrap(Events, 'loadScene', function (args) {
      var ev = Events.activeEvent();
      trace('event.scene', { title: ev && ev.title, scene: args[0] });
    });
    wrap(Events, 'endEvent', function () { trace('event.end', {}); });
    wrap(Events, 'damage', function (args) {
      var attacker = args[0], target = args[1];
      trace('combat.hit', {
        attacker: attacker && attacker.attr('id'), dmg: args[2], kind: args[3],
        targetHp: target && target.data('hp'), playerHp: World.health
      });
    });
    wrap(World, 'move', function () { trace('world.move', Object.assign(worldStatus(), { goal: S.trip && S.trip.goal })); });
    wrap(World, 'die', function () {
      trace('death', worldStatus());
      endTrip('died');
    });
    wrap(World, 'goHome', function () { endTrip('home'); });
    wrap(Path, 'embark', function () {
      S.trip = { started: elapsed(), goal: null };
      trace('trip.start', { outfit: Object.assign({}, Path.outfit), water: World.water, maxHp: World.getMaxHealth() });
    });
    wrap(Space, 'updateHull', function () { trace('space.hull', { hull: Space.hull, altitude: Space.altitude }); });
    wrap(Space, 'crash', function () { trace('space.crash', { altitude: Space.altitude }); });
    wrap(Space, 'endGame', function () {
      trace('game.win', { elapsed: Math.round(elapsed()) });
      snapshot('win');
      stop('game won');
    });
  }

  function endTrip(how) {
    if (!S.trip) return;
    trace('trip.end', { how: how, duration: Math.round(elapsed() - S.trip.started), stores: stores() });
    S.trip = null;
    S.lastTripEnd = elapsed();
  }

  // ---------------------------------------------------------------- helpers

  function have(k) { return $SM.get('stores["' + k + '"]', true) || 0; }
  function affordable(cost) {
    return Object.keys(cost).every(function (k) { return have(k) >= cost[k]; });
  }
  function missing(cost) {
    return Object.keys(cost).filter(function (k) { return have(k) < cost[k]; });
  }
  function ready(btn) { return btn && btn.length && !btn.hasClass('disabled'); }
  function owned(thing) {
    var c = Room.Craftables[thing];
    return c && c.type === 'building' ? $SM.get('game.buildings["' + thing + '"]', true) || 0 : have(thing);
  }
  function unlocked(mod) { return mod && mod.tab && mod.tab.length; }
  function temperature() { return $SM.get('game.temperature.value') || 0; }

  // ---------------------------------------------------------------- economy decisions
  // Each returns null or {priority, module, name, target, reason, run}.

  function fireDecision() {
    if (!Room.panel) return null;
    var fire = $SM.get('game.fire.value') || 0;
    var builder = $SM.get('game.builder.level');
    var want = builder < 3 ? Room.FireEnum.Roaring.value : Room.FireEnum.Burning.value;
    if (fire >= want) return null;
    var lit = fire > Room.FireEnum.Dead.value;
    var btn = $(lit ? '#stokeButton' : '#lightButton');
    var wood = $SM.get('stores.wood');
    var cost = lit ? Room._STOKE_COST : Room._LIGHT_FIRE_COST;
    if (!ready(btn) || (typeof wood === 'number' && wood < cost)) return null;
    return {
      priority: fire <= Room.FireEnum.Smoldering.value ? 100 : 60, module: Room,
      name: lit ? 'stoke fire' : 'light fire', target: null,
      reason: 'fire ' + fire + ' < wanted ' + want + (builder < 3 ? ' (stranger needs a hot room)' : ' (keeps the room warm enough to build)'),
      run: function () { btn.click(); }
    };
  }

  // The game destroys traps (beasts, thieves), so "owned" can go backwards.
  // High-water marks keep a regressing item from pinning the plan forever.
  function updateReached() {
    BUILD_PLAN.forEach(function (entry) {
      var n = owned(entry[0]);
      if (n > (S.reached[entry[0]] || 0)) S.reached[entry[0]] = n;
    });
  }

  function planCap(i) {
    var c = Room.Craftables[BUILD_PLAN[i][0]];
    return typeof c.maximum === 'number' ? Math.min(BUILD_PLAN[i][1], c.maximum) : BUILD_PLAN[i][1];
  }

  // The goal is the first entry never yet reached; entries that regressed are
  // maintenance, rebuilt only out of surplus so the plan keeps moving.
  function buildGoal() {
    updateReached();
    for (var i = 0; i < BUILD_PLAN.length; i++) {
      var thing = BUILD_PLAN[i][0];
      var c = Room.Craftables[thing];
      if (!c || !c.button) continue;
      if ((S.reached[thing] || 0) < planCap(i)) return { index: i, thing: thing, cost: c.cost() };
    }
    return null;
  }

  // What the current goal still needs, so nothing else spends it.
  function goalShortfall() {
    var goal = buildGoal();
    if (!goal) return {};
    var short = {};
    Object.keys(goal.cost).forEach(function (k) { short[k] = goal.cost[k]; });
    return short;
  }

  function buildDecision() {
    if (!Room.panel || temperature() <= Room.TempEnum.Cold.value) return null;
    var goal = buildGoal();
    if (!goal) return null;
    var pick = null, reason;
    if (affordable(goal.cost)) {
      pick = goal;
      reason = 'next in build plan (#' + (goal.index + 1) + ')';
    } else {
      var saving = Object.keys(goal.cost);
      // Rebuild anything destroyed, but only with what the goal does not need.
      for (var m = 0; m < BUILD_PLAN.length && !pick; m++) {
        var mThing = BUILD_PLAN[m][0], mc = Room.Craftables[mThing];
        if (!mc || !mc.button || mc.button.hasClass('disabled')) continue;
        if (owned(mThing) >= planCap(m)) continue;
        var mCost = mc.cost();
        if (!affordable(mCost)) continue;
        // Cheap relative to what we hold, so rebuilding barely delays the goal.
        var cheap = Object.keys(mCost).every(function (k) { return mCost[k] <= have(k) * MAINTENANCE_SHARE; });
        if (!cheap) continue;
        pick = { thing: mThing, cost: mCost };
        reason = 'rebuilding (destroyed) while saving ' + missing(goal.cost).join('/') + ' for ' + goal.thing;
      }
      for (var i = goal.index + 1; i < BUILD_PLAN.length && !pick; i++) {
        var thing = BUILD_PLAN[i][0], c = Room.Craftables[thing];
        if (!c || !c.button || c.button.hasClass('disabled')) continue;
        var cost = c.cost();
        if (owned(thing) >= planCap(i) || !affordable(cost)) continue;
        if (Object.keys(cost).some(function (k) { return saving.indexOf(k) !== -1; })) continue;
        pick = { thing: thing, cost: cost };
        reason = 'affordable while saving ' + missing(goal.cost).join('/') + ' for ' + goal.thing;
      }
    }
    if (!pick) return null;
    var btn = Room.Craftables[pick.thing].button;
    return {
      priority: 50, module: Room, name: 'build', target: pick.thing, reason: reason,
      run: function () { btn.click(); }
    };
  }

  function tradeDecision() {
    var goods = Room.TradeGoods;
    if (!$('#buyBtns').length || temperature() <= Room.TempEnum.Cold.value) return null;
    // Until the compass is bought nothing else may spend what it needs: it
    // unlocks the path, and everything after it.
    var reserve = (have('compass') < 1 && goods.compass && goods.compass.button) ? goods.compass.cost() : {};
    function buy(thing, reason, priority, ignoreReserve) {
      var g = goods[thing];
      if (!g || !g.button || g.button.hasClass('disabled')) return null;
      var cost = g.cost();
      if (!affordable(cost)) return null;
      if (!ignoreReserve && Object.keys(cost).some(function (k) { return have(k) - cost[k] < (reserve[k] || 0); })) return null;
      return { priority: priority || 55, module: Room, name: 'buy', target: thing, reason: reason, run: function () { g.button.click(); } };
    }
    // The compass opens the path; it outranks everything else in the shop.
    if (have('compass') < 1 && goods.compass.button) {
      var d = buy('compass', 'the compass opens the dusty path', 58, true);
      if (d) return d;
      var need = missing(goods.compass.cost());
      for (var i = 0; i < need.length; i++) {
        d = buy(need[i], 'short of ' + need[i] + ' for the compass', 56, true);
        if (d) return d;
      }
    }
    var goal = buildGoal();
    if (goal) {
      var short = missing(goal.cost);
      for (var j = 0; j < short.length; j++) {
        var g = goods[short[j]];
        if (!g) continue;
        var spends = Object.keys(g.cost());
        if (spends.some(function (k) { return short.indexOf(k) !== -1; })) continue;
        var d2 = buy(short[j], 'short of ' + short[j] + ' for ' + goal.thing);
        if (d2) return d2;
      }
    }
    if (unlocked(Path) && have('medicine') < 4) {
      var d3 = buy('medicine', 'keep 4 medicine for expeditions', 40);
      if (d3) return d3;
    }
    if (have('rifle') > 0 && have('bullets') < 20) {
      var d4 = buy('bullets', 'keep 20 bullets for the rifle', 40);
      if (d4) return d4;
    }
    if (unlocked(Ship) && shipNeedsAlloy()) {
      var d5 = buy('alien alloy', 'the ship needs alloy', 45);
      if (d5) return d5;
    }
    return null;
  }

  // What the village is currently saving up for: the build goal, plus the
  // compass while it is unbought.
  function savingFor() {
    var needs = goalShortfall();
    var compass = Room.TradeGoods.compass;
    if (have('compass') < 1 && compass && compass.button) {
      var c = compass.cost();
      Object.keys(c).forEach(function (k) { needs[k] = Math.max(needs[k] || 0, c[k]); });
    }
    return needs;
  }

  function workerTargets() {
    var pop = $SM.get('game.population') || 0;
    var current = $SM.get('game.workers') || {};
    var jobs = Object.keys(current).filter(function (j) { return j !== 'gatherer' && Outside._INCOME[j]; });
    var target = {}, notes = [];
    var needs = savingFor();
    jobs.forEach(function (j) { target[j] = Math.floor(pop * (WORKER_SHARES[j] || 0)); });
    function assigned() { return jobs.reduce(function (n, j) { return n + target[j]; }, 0); }
    function net(res) {
      var gatherers = pop - assigned();
      var n = gatherers * (Outside._INCOME.gatherer.stores[res] || 0);
      jobs.forEach(function (j) { n += target[j] * (Outside._INCOME[j].stores[res] || 0); });
      return n;
    }
    // Balancing: no resource may run dry within RUNWAY_TICKS income ticks.
    for (var guard = 0; guard < 500; guard++) {
      var short = null;
      var resources = {};
      jobs.concat('gatherer').forEach(function (j) { Object.keys(Outside._INCOME[j].stores).forEach(function (r) { resources[r] = 1; }); });
      Object.keys(resources).some(function (r) {
        var n = net(r);
        if (n >= 0) return false;
        // must not run dry...
        if (have(r) + RUNWAY_TICKS * n < 0) { short = r; return true; }
        // ...and must not shrink while we are saving up for it
        if (needs[r] && have(r) < needs[r]) { short = r; return true; }
        return false;
      });
      if (!short) break;
      var worst = null;
      jobs.forEach(function (j) {
        var use = Outside._INCOME[j].stores[short] || 0;
        if (use < 0 && target[j] > 0 && (!worst || use * target[j] < (Outside._INCOME[worst].stores[short] || 0) * target[worst])) worst = j;
      });
      if (!worst) break;
      target[worst]--;
      if (notes.indexOf(short) === -1) notes.push(short);
    }
    return { target: target, current: current, notes: notes };
  }

  function workerDecision() {
    if (!unlocked(Outside) || !$('#workers').length) return null;
    if (elapsed() - S.lastWorkerPass < WORKER_PASS_MS) return null;
    var plan = workerTargets();
    var changes = Object.keys(plan.target).filter(function (j) { return plan.target[j] !== (plan.current[j] || 0); });
    if (!changes.length) { S.lastWorkerPass = elapsed(); return null; }
    return {
      priority: 35, module: Outside, name: 'assign workers', target: null,
      reason: 'population shares' + (plan.notes.length ? ', trimmed so ' + plan.notes.join('/') + ' last ' + RUNWAY_TICKS + ' ticks' : ''),
      run: function () {
        var before = Object.assign({}, $SM.get('game.workers'));
        // Free workers first so there are gatherers to reassign.
        changes.sort(function (a, b) { return (plan.target[a] - (plan.current[a] || 0)) - (plan.target[b] - (plan.current[b] || 0)); });
        changes.forEach(function (j) {
          var row = $('#workers_row_' + j.replace(' ', '-'));
          for (var guard = 0; guard < 200; guard++) {
            var cur = $SM.get('game.workers["' + j + '"]') || 0, d = plan.target[j] - cur;
            if (!d) break;
            var cls = d > 0 ? (d >= 10 ? '.upManyBtn' : '.upBtn') : (d <= -10 ? '.dnManyBtn' : '.dnBtn');
            $(cls, row).first().click();
            if (($SM.get('game.workers["' + j + '"]') || 0) === cur) break; // no gatherers left
          }
        });
        S.lastWorkerPass = elapsed();
        return { before: before, after: Object.assign({}, $SM.get('game.workers')) };
      }
    };
  }

  function gatherDecision() {
    if (!unlocked(Outside)) return null;
    var traps = $('#trapsButton'), gather = $('#gatherButton');
    if (ready(traps)) return { priority: 45, module: Outside, name: 'check traps', reason: 'traps off cooldown', run: function () { traps.click(); } };
    if (ready(gather)) return { priority: 40, module: Outside, name: 'gather wood', reason: 'gather off cooldown', run: function () { gather.click(); } };
    return null;
  }

  function shipNeedsAlloy() {
    return ($SM.get('game.spaceShip.hull') || 0) < SHIP_HULL_TARGET || ($SM.get('game.spaceShip.thrusters') || 0) < SHIP_THRUSTER_TARGET;
  }

  function shipDecision() {
    if (!unlocked(Ship)) return null;
    var hull = $SM.get('game.spaceShip.hull') || 0, thrusters = $SM.get('game.spaceShip.thrusters') || 0;
    if (have('alien alloy') >= Ship.ALLOY_PER_HULL && hull < SHIP_HULL_TARGET && hull <= thrusters * 3) {
      return { priority: 70, module: Ship, name: 'reinforce hull', reason: 'hull ' + hull + ' < ' + SHIP_HULL_TARGET, run: function () { $('#reinforceButton').click(); } };
    }
    if (have('alien alloy') >= Ship.ALLOY_PER_THRUSTER && thrusters < SHIP_THRUSTER_TARGET) {
      return { priority: 70, module: Ship, name: 'upgrade engine', reason: 'thrusters ' + thrusters + ' < ' + SHIP_THRUSTER_TARGET, run: function () { $('#engineButton').click(); } };
    }
    if (have('alien alloy') >= Ship.ALLOY_PER_HULL && hull < SHIP_HULL_TARGET) {
      return { priority: 70, module: Ship, name: 'reinforce hull', reason: 'hull ' + hull + ' < ' + SHIP_HULL_TARGET, run: function () { $('#reinforceButton').click(); } };
    }
    var lift = $('#liftoffButton');
    if (hull >= SHIP_HULL_TARGET && ready(lift)) {
      snapshot('liftoff');
      return { priority: 72, module: Ship, name: 'lift off', reason: 'hull ' + hull + ', thrusters ' + thrusters, run: function () { lift.click(); } };
    }
    return null;
  }

  // ---------------------------------------------------------------- expeditions

  function bestOf(list) {
    var best = null;
    list.forEach(function (w) {
      if (have(w) > 0 && (!best || World.Weapons[w].damage > World.Weapons[best].damage)) best = w;
    });
    return best;
  }

  function outfitPlan() {
    var plan = {}, space = Path.getCapacity();
    function add(k, n) {
      n = Math.min(n, have(k), Math.floor(space / Path.getWeight(k)));
      if (n > 0) { plan[k] = n; space -= n * Path.getWeight(k); }
    }
    var melee = bestOf(MELEE), ranged = bestOf(RANGED);
    if (melee) add(melee, 1);
    if (ranged) add(ranged, 1);
    var movesPerFood = World.MOVES_PER_FOOD * ($SM.hasPerk('slow metabolism') ? World.PERK_EFFECTS.slowMetabolism : 1);
    var movesPerWater = World.MOVES_PER_WATER * ($SM.hasPerk('desert rat') ? World.PERK_EFFECTS.desertRat : 1);
    // enough meat to walk as far as the water allows, plus some to heal with
    add('cured meat', Math.ceil(World.getMaxWater() * movesPerWater / movesPerFood) + 6);
    KIT.forEach(function (k) {
      if (k[0] === 'bullets' && ranged !== 'rifle') return;
      if (k[0] === 'energy cell' && ranged !== 'laser rifle' && ranged !== 'plasma rifle') return;
      add(k[0], k[1]);
    });
    return plan;
  }

  function embarkDecision() {
    if (!unlocked(Path) || S.trip) return null;
    if (have('cured meat') < 10) return null;
    if (elapsed() - S.lastTripEnd < TRIP_REST_MS) return null;
    var btn = $('#embarkButton');
    if (btn.data('onCooldown')) return null;
    var plan = outfitPlan();
    var outfit = Path.outfit || {};
    var keys = Object.keys(Object.assign({}, plan, outfit));
    var matches = keys.every(function (k) { return (outfit[k] || 0) === (plan[k] || 0); });
    if (!matches) {
      return {
        priority: 30, module: Path, name: 'pack', target: null, reason: 'outfit for expedition: ' + JSON.stringify(plan),
        run: function () {
          keys.forEach(function (k) {
            var row = $('#outfit_row_' + k.replace(' ', '-'));
            for (var guard = 0; guard < 300; guard++) {
              var cur = Path.outfit[k] || 0, want = plan[k] || 0;
              if (cur === want) break;
              $(cur < want ? '.upBtn' : '.dnBtn', row).first().click();
              if ((Path.outfit[k] || 0) === cur) break;
            }
          });
          return Object.assign({}, Path.outfit);
        }
      };
    }
    if (!ready(btn)) return null;
    return { priority: 30, module: Path, name: 'embark', reason: 'packed and rested', run: function () { btn.click(); } };
  }

  function isEventTile(tile, x, y) {
    if (tile === World.TILE.EXECUTIONER) return true;
    if (!World.LANDMARKS[tile]) return false;
    return !(tile === World.TILE.OUTPOST && World.outpostUsed(x, y));
  }

  function safeRadius() {
    if (have('kinetic armour') > 0) return 99;
    if (have('s armour') > 0) return 30;
    if (have('i armour') > 0) return 18;
    if (have('l armour') > 0) return 12;
    return 8;
  }

  function landmarkAllowed(tile, x, y) {
    if ((S.landmarkAttempts[x + ',' + y] || 0) >= 2) return false;
    if (World.getDistance([x, y]) > safeRadius()) return false;
    if (tile === World.TILE.EXECUTIONER) return have('s armour') > 0 && World.getMaxHealth() >= 45 && (Path.outfit.medicine || 0) >= 3;
    if (tile === World.TILE.CITY) return have('i armour') > 0;
    return true;
  }

  // Breadth-first distances to `target`. Tiles that would start an event are
  // reachable as destinations but never walked through.
  function bfs(target) {
    var size = World.RADIUS * 2 + 1, map = World.state.map;
    var dist = [];
    for (var i = 0; i < size; i++) { dist.push(new Array(size).fill(Infinity)); }
    var q = [target], head = 0;
    dist[target[0]][target[1]] = 0;
    while (head < q.length) {
      var p = q[head++];
      [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(function (d) {
        var x = p[0] + d[0], y = p[1] + d[1];
        if (x < 0 || y < 0 || x >= size || y >= size || dist[x][y] !== Infinity) return;
        var tile = map[x][y];
        var home = x === World.VILLAGE_POS[0] && y === World.VILLAGE_POS[1];
        dist[x][y] = dist[p[0]][p[1]] + 1;
        if (!home && World.state.mask[x][y] && isEventTile(tile, x, y)) return;
        q.push([x, y]);
      });
    }
    return dist;
  }

  function movesLeft() {
    var perFood = World.MOVES_PER_FOOD * ($SM.hasPerk('slow metabolism') ? World.PERK_EFFECTS.slowMetabolism : 1);
    var perWater = World.MOVES_PER_WATER * ($SM.hasPerk('desert rat') ? World.PERK_EFFECTS.desertRat : 1);
    return Math.min(World.water * perWater, ((Path.outfit['cured meat'] || 0) + 1) * perFood);
  }

  function chooseGoal() {
    var pos = World.curPos, map = World.state.map, mask = World.state.mask, size = World.RADIUS * 2 + 1;
    var fromHere = bfs(pos);
    var toHome = bfs(World.VILLAGE_POS);
    var range = movesLeft();
    var homeD = toHome[pos[0]][pos[1]];
    var hpLow = World.health < World.getMaxHealth() * 0.3 && !(Path.outfit['cured meat'] > 0) && !(Path.outfit.medicine > 0);
    if (range - homeD <= RETURN_MARGIN || hpLow) {
      return { pos: World.VILLAGE_POS.slice(), why: hpLow ? 'hurt with nothing to heal' : 'supplies cover only the walk home (' + range + ' moves, ' + homeD + ' home)' };
    }
    var best = null;
    function consider(x, y, kind, extra) {
      var d = fromHere[x][y];
      if (d === Infinity || d === 0) return;
      var back = Math.abs(x - World.VILLAGE_POS[0]) + Math.abs(y - World.VILLAGE_POS[1]);
      if (d + back + RETURN_MARGIN > range && kind !== 'outpost') return;
      var score = d - (extra || 0);
      if (!best || score < best.score) best = { pos: [x, y], score: score, kind: kind, d: d };
    }
    var thirsty = World.water < World.getMaxWater() * 0.5;
    for (var x = 0; x < size; x++) {
      for (var y = 0; y < size; y++) {
        if (!mask[x][y]) continue;
        var tile = map[x][y];
        if (isEventTile(tile, x, y)) {
          if (tile === World.TILE.OUTPOST) { if (thirsty && fromHere[x][y] < World.water) consider(x, y, 'outpost', 100); }
          else if (landmarkAllowed(tile, x, y)) consider(x, y, 'landmark ' + tile, 20);
        }
      }
    }
    if (!best) {
      // frontier: a seen tile next to an unseen one, within reach
      for (var fx = 0; fx < size; fx++) {
        for (var fy = 0; fy < size; fy++) {
          if (!mask[fx][fy] || World.getDistance([fx, fy]) > safeRadius()) continue;
          var edge = [[0, -1], [0, 1], [-1, 0], [1, 0]].some(function (d) {
            var nx = fx + d[0], ny = fy + d[1];
            return nx >= 0 && ny >= 0 && nx < size && ny < size && !mask[nx][ny];
          });
          if (edge) consider(fx, fy, 'frontier', 0);
        }
      }
    }
    if (!best) return { pos: World.VILLAGE_POS.slice(), why: 'nothing reachable left to explore' };
    return { pos: best.pos, why: best.kind + ' ' + best.d + ' moves away' };
  }

  function worldStep() {
    if (World.dead || !World.state || Engine.keyLock) return;
    var goal = chooseGoal();
    var key = goal.pos.join(',');
    if (!S.trip) S.trip = { started: elapsed(), goal: null };
    if (S.trip.goal !== key) {
      S.trip.goal = key;
      trace('world.goal', { goal: goal.pos, why: goal.why, status: worldStatus() });
      S.intent = 'walk to ' + key + ' — ' + goal.why;
    }
    var dist = bfs(goal.pos), p = World.curPos;
    var moves = [[World.NORTH, 'moveNorth'], [World.SOUTH, 'moveSouth'], [World.WEST, 'moveWest'], [World.EAST, 'moveEast']];
    var here = dist[p[0]][p[1]];
    for (var i = 0; i < moves.length; i++) {
      var nx = p[0] + moves[i][0][0], ny = p[1] + moves[i][0][1];
      if (dist[nx] && dist[nx][ny] === here - 1) { World[moves[i][1]](); return; }
    }
    // Unreachable: count it as an attempt so the next choice differs.
    S.landmarkAttempts[key] = (S.landmarkAttempts[key] || 0) + 1;
    trace('world.stuck', { goal: goal.pos });
  }

  // ---------------------------------------------------------------- events and combat

  function combatTick() {
    var max = World.getMaxHealth(), hp = World.health;
    var heals = [['#hypo', 0.4], ['#meds', 0.4], ['#eat', 0.6]];
    for (var i = 0; i < heals.length; i++) {
      var h = $(heals[i][0]);
      if (hp < max * heals[i][1] && ready(h)) {
        act('heal', heals[i][0].slice(1), 'hp ' + hp + '/' + max, function () { h.click(); });
        return;
      }
    }
    var shield = $('#shld');
    if (ready(shield)) { act('shield', null, 'shield off cooldown', function () { shield.click(); }); return; }
    var attacks = $('#attackButtons .button').filter(function () { return !$(this).hasClass('disabled'); });
    attacks.each(function () {
      var b = $(this);
      act('attack', b.attr('id').slice(7), 'weapon off cooldown', function () { b.click(); });
    });
  }

  function scoreChoice(ev, sceneName, id, info) {
    var score = 0, why = [];
    var next = info ? info.nextScene : 'end';
    if (info && info.nextEvent) { score += 8; why.push('continues'); }
    else if (next && next !== 'end') { score += 8; why.push('continues'); }
    if (info && info.reward) {
      var r = Object.keys(info.reward).reduce(function (n, k) { return n + info.reward[k]; }, 0);
      score += Math.min(5, r / 10); why.push('reward');
    }
    if (info && info.cost) {
      var c = Object.keys(info.cost).reduce(function (n, k) { return n + info.cost[k] * (COST_WEIGHT[k] || 0.02); }, 0);
      score -= c; if (c) why.push('costs ' + JSON.stringify(info.cost));
      // Never hand over what the current build goal is short of, and treat any
      // cost as dearer the less of it we have.
      var short = Engine.activeModule === World ? {} : goalShortfall();
      Object.keys(info.cost).forEach(function (k) {
        var stock = Events.getQuantity(k);
        score -= 10 * info.cost[k] / Math.max(1, stock);
        if (short[k] && stock - info.cost[k] < short[k]) {
          score -= 15;
          why.push('needs the ' + k + ' for the build plan');
        }
        // keep a reserve: no single choice eats half of what we hold
        if (info.cost[k] > stock * 0.5) {
          score -= 12;
          why.push('would spend over half the ' + k);
        }
      });
    }
    var text = (info && info.text) || id;
    if (RETREAT_WORDS.test(text) || RETREAT_WORDS.test(id)) { score -= 3; why.push('retreats'); }
    if (Engine.activeModule === World && World.health < World.getMaxHealth() * 0.35 && (!next || next === 'end')) {
      score += 20; why.push('low hp, get out');
    }
    var seen = S.choiceCounts[ev.title + '/' + sceneName + '/' + id] || 0;
    if (seen) { score -= 4 * seen; why.push('chosen ' + seen + 'x already'); }
    return { score: Math.round(score * 100) / 100, why: why.join(', ') || 'neutral' };
  }

  function eventTick() {
    var ev = Events.activeEvent();
    var panel = ev.eventPanel;
    if (!panel || Engine.activeModule === Space) return;
    var sceneName = Events.activeScene;
    var scene = ev.scenes[sceneName] || {};
    // A choice ends with a fade; don't click again until the scene moves on.
    if (S.lastChoice && S.lastChoice.title === ev.title && S.lastChoice.scene === sceneName
      && elapsed() - S.lastChoice.at < 1000) return;
    if (scene.combat && $('#enemy', panel).length && !Events.fought) { combatTick(); return; }

    // Loot first. "take everything" and "leave" both start on a cooldown, and
    // leaving while loot is on the table throws it away.
    var lootRows = $('#lootButtons .lootRow', panel);
    if (lootRows.length) {
      var take = $('#loot_takeEverything', panel);
      if (ready(take)) {
        S.lootWait = null;
        act('take loot', null, 'take everything that fits', function () { take.click(); return Object.assign({}, Path.outfit); });
        return;
      }
      var one = lootRows.find('.lootTakeAll').filter(function () { return !$(this).hasClass('disabled'); }).first();
      if (one.length) {
        S.lootWait = null;
        act('take loot', one.closest('.lootRow').data('item'), 'taking what fits', function () { one.click(); return Object.assign({}, Path.outfit); });
        return;
      }
      // Nothing takeable (bag full, or buttons still cooling down): wait briefly.
      if (!S.lootWait || S.lootWait.scene !== sceneName) S.lootWait = { scene: sceneName, since: elapsed() };
      if (elapsed() - S.lootWait.since < 3000) return;
    }
    var eat = $('#eat', panel);
    if (Engine.activeModule === World && ready(eat) && World.health < World.getMaxHealth() * 0.6) {
      act('heal', 'eat', 'hp ' + World.health + '/' + World.getMaxHealth() + ' after the fight', function () { eat.click(); });
      return;
    }

    var buttons = $('#exitButtons .button', panel).filter(function () {
      return !$(this).hasClass('disabled') && !$(this).data('onCooldown');
    });
    if (!buttons.length) return; // waiting on a cooldown or animation

    var ids = buttons.map(function () { return this.id; }).get();
    var pick = null, reason = '';
    var rule = EVENT_RULES[ev.title];
    if (rule) {
      pick = rule.filter(function (id) { return ids.indexOf(id) !== -1; })[0] || null;
      if (pick) reason = 'rule for "' + ev.title + '"';
    }
    var scored = ids.map(function (id) {
      var s = scoreChoice(ev, sceneName, id, scene.buttons && scene.buttons[id]);
      return { id: id, score: s.score, why: s.why };
    });
    if (!pick) {
      var best = scored.reduce(function (a, b) { return b.score > a.score ? b : a; });
      pick = best.id;
      reason = 'highest score ' + best.score + ' (' + best.why + ')';
    }
    var k = ev.title + '/' + sceneName + '/' + pick;
    S.choiceCounts[k] = (S.choiceCounts[k] || 0) + 1;
    S.lastChoice = { title: ev.title, scene: sceneName, at: elapsed() };
    var btn = $('#' + pick.replace(/([^\w-])/g, '\\$1'), panel);
    trace('event.choice', { title: ev.title, scene: sceneName, choice: pick, reason: reason, options: scored });
    act('choose', pick, reason, function () { btn.click(); });
  }

  // ---------------------------------------------------------------- space

  function spaceTick() {
    if (!S.running) return;
    if (Engine.activeModule !== Space || Space.done || Space.shipX == null) return;
    var sx = Space.shipX, sy = Space.shipY;
    var lanes = [-90, -45, 0, 45, 90];
    var costs = lanes.map(function (off) {
      var x = sx + off, cost = (x < 20 || x > 680) ? 1e6 : Math.abs(off) * 0.01;
      $('.asteroid').each(function () {
        var a = $(this), top = parseFloat(a.css('top')) || 0;
        var gap = sy - (top + (a.data('height') || 20));
        if (gap < -5 || gap > 320) return;
        if (a.data('xMin') - 18 <= x && a.data('xMax') + 18 >= x) cost += 1000 / Math.max(gap, 10);
      });
      return cost;
    });
    var best = 0;
    for (var i = 1; i < lanes.length; i++) if (costs[i] < costs[best]) best = i;
    var dir = lanes[best] < 0 ? -1 : lanes[best] > 0 ? 1 : 0;
    if (costs[2] <= costs[best] + 1e-9) dir = 0;
    Space.left = dir < 0;
    Space.right = dir > 0;
    if (dir !== S.steer) {
      S.steer = dir;
      trace('space.steer', { dir: dir < 0 ? 'left' : dir > 0 ? 'right' : 'hold', x: Math.round(sx), altitude: Space.altitude, hull: Space.hull });
    }
  }

  // ---------------------------------------------------------------- main loop

  function travel(mod, why) {
    act('travel', moduleNameOf(mod), why, function () { Engine.travelTo(mod); });
  }
  function moduleNameOf(m) {
    return m === Room ? 'Room' : m === Outside ? 'Outside' : m === Path ? 'Path' : m === Ship ? 'Ship' : m === Fabricator ? 'Fabricator' : '?';
  }

  // One decision. The game's own button cooldowns and costs gate what it can do.
  function decide() {
    try {
      if (Space.done) { stop('game over'); return; }
      if (elapsed() - S.lastSnapshot >= SNAPSHOT_MS) snapshot('periodic');
      if (Engine.activeModule === Space) return;
      if (World.dead && Engine.activeModule === World) return; // death fade-out
      if (Events.activeEvent()) { eventTick(); return; }
      if (Engine.activeModule === World) { worldStep(); return; }
      if (Engine.keyLock) return;

      var options = [fireDecision(), shipDecision(), tradeDecision(), buildDecision(), gatherDecision(), workerDecision(), embarkDecision()]
        .filter(Boolean);
      if (!options.length) { S.intent = 'waiting'; return; }
      options.sort(function (a, b) {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return (b.module === Engine.activeModule) - (a.module === Engine.activeModule);
      });
      var d = options[0];
      if (d.module && d.module !== Engine.activeModule) {
        travel(d.module, 'to ' + d.name + (d.target ? ' ' + d.target : ''));
        return;
      }
      act(d.name, d.target || null, d.reason, d.run);
    } catch (e) {
      trace('bot.error', { message: e.message, stack: String(e.stack).split('\n').slice(0, 4).join(' | ') });
      console.error('[bot]', e);
    }
  }

  // A throttled background tab wakes rarely, and the game catches up with a
  // burst of overdue timers; allow a matching burst of decisions so cooldowns
  // that came due meanwhile are not wasted.
  function tick() {
    if (!S.running) return;
    var stalledBefore = S.stalled;
    accountForStall();
    var budget = S.stalled > stalledBefore ? 6 : 1;
    for (var i = 0; i < budget && S.running; i++) decide();
  }

  function begin() {
    clearInterval(S.timer); clearInterval(S.spaceTimer); clearInterval(S.flushTimer);
    S.lastTickVirtual = now();
    S.timer = setInterval(tick, TICK_MS);
    S.spaceTimer = setInterval(spaceTick, SPACE_TICK_MS);
    // flush on real time so traces arrive steadily at any warp
    var realInterval = window.__timewarp ? 2000 * window.__timewarp.get() : 2000;
    S.flushTimer = setInterval(function () { flush(false); }, realInterval);
  }

  function start(opts) {
    opts = opts || {};
    if (opts.fresh || !S.runId) {
      S.runId = new Date(window.__timewarp ? window.__timewarp.realNow() : Date.now()).toISOString().replace(/[:.]/g, '-');
      S.seq = 0; S.elapsedBefore = 0; S.loadVirtual = now(); S.trace = []; S.milestones = [];
      S.landmarkAttempts = {}; S.lastTripEnd = -Infinity; S.lastWorkerPass = -Infinity; S.stalled = 0; S.reached = {};
    }
    S.running = true;
    trace('run.start', {
      runId: S.runId, fresh: !!opts.fresh, warp: window.__timewarp ? window.__timewarp.get() : 1,
      overrides: window.__DESIGNER_OVERRIDES || {}, userAgent: navigator.userAgent
    });
    if (opts.fresh) {
      // Restart through the game's own reset; the bot resumes after the reload.
      saveSession();
      flush(true);
      Engine.deleteSave();
      return status();
    }
    snapshot('start');
    saveSession();
    begin();
    return status();
  }

  function stop(why) {
    if (!S.running) return status();
    trace('run.stop', { why: why || 'stopped by designer', elapsed: Math.round(elapsed()) });
    Space.left = Space.right = false;
    S.running = false;
    clearInterval(S.timer); clearInterval(S.spaceTimer); clearInterval(S.flushTimer);
    flush(true);
    saveSession();
    return status();
  }

  function resume(saved) {
    S.runId = saved.runId; S.seq = saved.seq || 0; S.elapsedBefore = saved.elapsed || 0; S.loadVirtual = now();
    S.landmarkAttempts = saved.landmarkAttempts || {}; S.milestones = saved.milestones || [];
    S.reached = saved.reached || {};
    S.stalled = 0;
    if (typeof saved.lastTripEnd === 'number') S.lastTripEnd = elapsed() + saved.lastTripEnd;
    S.running = true;
    trace('run.resume', { runId: S.runId, warp: window.__timewarp ? window.__timewarp.get() : 1, overrides: window.__DESIGNER_OVERRIDES || {} });
    snapshot('resume');
    begin();
  }

  function status() {
    return {
      running: S.running, runId: S.runId, seq: S.seq, elapsed: Math.round(elapsed()), module: moduleName(),
      intent: S.intent, milestones: S.milestones.slice(), warp: window.__timewarp ? window.__timewarp.get() : 1,
      stalled: Math.round(S.stalled), hidden: document.hidden,
      trip: S.trip ? { goal: S.trip.goal, status: worldStatus() } : null
    };
  }

  window.__bot = {
    start: start,
    stop: function () { return stop(); },
    step: function () { var r = S.running; S.running = true; decide(); S.running = r; flush(false); return status(); },
    status: status,
    since: function (seq) { return S.trace.filter(function (e) { return e.seq > seq; }); },
    setWarp: function (k) {
      var f = window.__timewarp ? window.__timewarp.set(k) : 1;
      trace('run.warp', { warp: f });
      if (S.running) begin();
      return f;
    }
  };

  installTraceHooks();

  // Resume a run that was going when the page reloaded (apply & reload, new game).
  $(function () {
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { /* ignore */ }
    if (saved && saved.running && saved.runId) setTimeout(function () { resume(saved); }, 500);
  });
  window.addEventListener('pagehide', function () { if (S.running) { flush(true); saveSession(); } });
})();
