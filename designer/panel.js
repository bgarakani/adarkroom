/**
 * Tuning panel. Reads the parameter catalog that designer/game-hook.js builds
 * inside the game iframe, edits a draft of overrides, and on apply saves them
 * to the server and reloads the game.
 */
(function () {
	'use strict';

	var ROOTS = {
		Room: ['The Room', 'fire, stranger, building and trading costs'],
		Outside: ['Outside', 'gathering, traps, population, worker income'],
		Path: ['Path', 'bag space and item weights'],
		World: ['World', 'map, survival, weapons, perks'],
		Events: ['Events', 'event timing, encounters, setpieces, loot'],
		Ship: ['Starship', 'hull, thrusters, liftoff'],
		Space: ['Space', 'flight and asteroids'],
		Fabricator: ['Fabricator', 'alien alloy crafting']
	};
	// Events is two levels deep (Events › Setpieces › city) before it gets manageable.
	var SECTION_DEPTH = { Events: 2 };

	// Hand-written notes for the parameters a designer reaches for first.
	// unit: ms | s | min | prob | a resource name | free text
	var META = {
		'Room/_STOKE_COOLDOWN': { unit: 's', hint: 'cooldown on the light and stoke buttons' },
		'Room/_FIRE_COOL_DELAY': { unit: 'ms', hint: 'after a stoke, time until the fire drops a level' },
		'Room/_ROOM_WARM_DELAY': { unit: 'ms', hint: 'room temperature moves one step toward the fire this often' },
		'Room/_BUILDER_STATE_DELAY': { unit: 'ms', hint: 'how often the stranger checks whether the room is warm enough to recover' },
		'Room/_NEED_WOOD_DELAY': { unit: 'ms', hint: 'from the stranger arriving until the forest unlocks' },
		'Room/_LIGHT_FIRE_COST': { unit: 'wood', hint: 'wood needed to light the fire' },
		'Room/_STOKE_COST': { unit: 'wood', hint: 'wood used per stoke' },
		'Room/_FOREST_START_WOOD': { unit: 'wood', hint: 'wood in stores when the forest unlocks' },
		'Outside/_GATHER_DELAY': { unit: 's', hint: 'cooldown on "gather wood"' },
		'Outside/_TRAPS_DELAY': { unit: 's', hint: 'cooldown on "check traps"' },
		'Outside/_POP_DELAY/0': { unit: 'min', hint: 'shortest wait between new villagers' },
		'Outside/_POP_DELAY/1': { unit: 'min', hint: 'longest wait between new villagers' },
		'Outside/_HUT_ROOM': { unit: 'villagers', hint: 'villagers each hut houses' },
		'Outside/_GATHER_AMOUNT': { unit: 'wood', hint: 'wood per gather' },
		'Outside/_GATHER_AMOUNT_CART': { unit: 'wood', hint: 'wood per gather once the cart is built' },
		'Events/_EVENT_TIME_RANGE/0': { unit: 'min', hint: 'shortest wait between random events' },
		'Events/_EVENT_TIME_RANGE/1': { unit: 'min', hint: 'longest wait between random events' },
		'World/RADIUS': { unit: 'tiles', hint: 'map radius; takes effect on a new game only', newGame: true },
		'World/STICKINESS': { unit: 'prob', hint: 'chance a tile copies its neighbour; new maps only', newGame: true },
		'World/LIGHT_RADIUS': { unit: 'tiles', hint: 'how far you can see on the map' },
		'World/BASE_WATER': { unit: 'water', hint: 'water carried with no upgrades' },
		'World/MOVES_PER_FOOD': { unit: 'moves' },
		'World/MOVES_PER_WATER': { unit: 'moves' },
		'World/DEATH_COOLDOWN': { unit: 's', hint: 'wait before embarking again after dying' },
		'World/FIGHT_CHANCE': { unit: 'prob', hint: 'chance of an encounter per move' },
		'World/FIGHT_DELAY': { unit: 'moves', hint: 'minimum moves between fights' },
		'World/BASE_HEALTH': { unit: 'hp' },
		'World/BASE_HIT_CHANCE': { unit: 'prob', hint: 'player hit chance' },
		'World/MEAT_HEAL': { unit: 'hp' },
		'World/MEDS_HEAL': { unit: 'hp' },
		'World/HYPO_HEAL': { unit: 'hp' },
		'Path/DEFAULT_BAG_SPACE': { unit: 'weight', hint: 'bag space with no upgrades' },
		'Ship/LIFTOFF_COOLDOWN': { unit: 's' },
		'Ship/ALLOY_PER_HULL': { unit: 'alloy' },
		'Ship/ALLOY_PER_THRUSTER': { unit: 'alloy' }
	};

	var state = {
		catalog: [],       // [{path, names, value, kind}]
		byPath: {},
		saved: {},         // overrides on the server
		draft: {},         // overrides being edited
		view: 'all',
		query: '',
		rendered: false
	};

	var $ = function (sel) { return document.querySelector(sel); };
	var frame = $('#game');
	var paramsEl = $('#params');

	function el(tag, attrs, children) {
		var node = document.createElement(tag);
		if (attrs) Object.keys(attrs).forEach(function (k) {
			if (k === 'text') node.textContent = attrs[k];
			else if (k === 'className') node.className = attrs[k];
			else node.setAttribute(k, attrs[k]);
		});
		(children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
		return node;
	}

	// ---------- describing a parameter ----------

	function segs(p) { return p.path.split('/'); }
	function lastKey(p) { var s = segs(p); return s[s.length - 1]; }

	function unitOf(p) {
		if (META[p.path] && META[p.path].unit) return META[p.path].unit;
		var s = segs(p), key = lastKey(p);
		if (p.kind === 'cost' || p.kind === 'costStep') return s[s.indexOf('cost()') + 1];
		if (p.kind === 'threshold') return 'prob';
		if (s.indexOf('TILE_PROBS') !== -1) return 'prob';
		if (/^(chance|hit|rollUnder)$/.test(key) || /CHANCE$/.test(key)) return 'prob';
		if (/cooldown|COOLDOWN|attackDelay/.test(key)) return 's';
		if (s[1] === '_INCOME' && key === 'delay') return 's';
		if (s[1] === '_INCOME' && s[3] === 'stores') return 'per tick';
		if (/DELAY|DURATION|TICK|_SPEED$|INTERVAL|_FADE$/.test(key)) return 'ms';
		return '';
	}

	function hintOf(p) {
		if (META[p.path] && META[p.path].hint) return META[p.path].hint;
		var s = segs(p);
		if (p.kind === 'threshold') return 'rolls below this lead here (lowest matching threshold wins)';
		if (p.kind === 'costStep') return 'added to the cost for each one already owned';
		if (s[1] === 'LANDMARKS' || s[1] === 'CACHE_LANDMARK' || s[1] === 'TILE_PROBS') return 'new maps only';
		if (s[1] === 'TrapDrops' && lastKey(p) === 'rollUnder') return 'cumulative: roll under this and above the previous drop';
		return '';
	}

	function friendly(value, unit) {
		if (unit === 'ms' && value >= 1000) {
			var sec = value / 1000;
			return sec >= 60 ? '= ' + +(sec / 60).toFixed(2) + ' min' : '= ' + +sec.toFixed(2) + ' s';
		}
		if (unit === 's' && value >= 60) return '= ' + +(value / 60).toFixed(2) + ' min';
		if (unit === 'prob') return '= ' + +(value * 100).toFixed(2) + '%';
		return '';
	}

	function displayName(p) {
		var key = lastKey(p);
		if (p.kind === 'cost') return segs(p)[segs(p).indexOf('cost()') + 1] + ' cost';
		if (p.kind === 'costStep') return '+ per owned';
		if (p.kind === 'threshold') return 'next scene → ' + key.slice(1);
		var s = segs(p);
		if (/^\d+$/.test(key) && s.length > 1) return s[s.length - 2] + ' [' + key + ']';
		return key;
	}

	// Where a parameter sits: root › section › group (breadcrumb) › field.
	function groupSegs(p) {
		var s = segs(p);
		var ci = s.indexOf('cost()');
		if (ci !== -1) return s.slice(0, ci);
		if (p.kind === 'threshold') return s.slice(0, -2);
		if (/^\d+$/.test(lastKey(p)) && s.length > 2) {
			// short numeric arrays like _POP_DELAY read better as one row group
			var parent = s.slice(0, -1);
			var siblings = state.catalog.filter(function (q) { return q.path.indexOf(parent.join('/') + '/') === 0; });
			if (siblings.length <= 3) return s.slice(0, -2);
		}
		return s.slice(0, -1);
	}

	function labelAt(p, i) {
		var s = segs(p), name = p.names && p.names[i];
		if (!name) return s[i];
		return /^\d+$/.test(s[i]) ? name : s[i] + ' (' + name + ')';
	}

	function sectionKey(p) {
		var gs = groupSegs(p);
		var depth = SECTION_DEPTH[gs[0]] || 1;
		if (gs.length <= 1) return gs[0] + '/·general';
		return gs.slice(0, 1 + depth).join('/');
	}

	function sectionTitle(key, sample) {
		var s = key.split('/');
		if (s[1] === '·general') return 'general';
		var parts = [];
		for (var i = 1; i < s.length; i++) parts.push(labelAt(sample, i));
		return parts.join(' › ');
	}

	function groupTitle(p, fromIndex) {
		var gs = groupSegs(p), parts = [];
		for (var i = fromIndex; i < gs.length; i++) parts.push(labelAt(p, i));
		return parts;
	}

	// ---------- values and validation ----------

	function current(p) { return p.path in state.draft ? state.draft[p.path] : p.value; }

	function fieldWarning(p, v) {
		if (!isFinite(v)) return 'not a number';
		var unit = unitOf(p);
		if (unit === 'prob' && (v < 0 || v > 1)) return 'probabilities run from 0 to 1';
		if (v < 0 && p.value >= 0 && !(segs(p)[1] === '_INCOME' || segs(p).indexOf('stores') !== -1)) return 'negative value';
		return '';
	}

	function groupWarnings(prefix) {
		var warnings = [];
		function vals(pfx) {
			return state.catalog.filter(function (q) { return q.path.indexOf(pfx) === 0; }).map(current);
		}
		if (prefix === 'World/TILE_PROBS') {
			var sum = vals('World/TILE_PROBS/').reduce(function (a, b) { return a + b; }, 0);
			if (Math.abs(sum - 1) > 1e-9) warnings.push('terrain probabilities sum to ' + +sum.toFixed(4) + '; they should sum to 1');
		}
		if (prefix === 'Outside/TrapDrops/0' || prefix.indexOf('Outside/TrapDrops') === 0) {
			var r = state.catalog.filter(function (q) { return /^Outside\/TrapDrops\/\d+\/rollUnder$/.test(q.path); }).map(current);
			for (var i = 1; i < r.length; i++) if (r[i] < r[i - 1]) { warnings.push('trap drop rollUnder values must increase down the list'); break; }
			if (r.length && r[r.length - 1] < 1) warnings.push('last trap drop rollUnder is below 1; some checks will find nothing');
		}
		['Outside/_POP_DELAY', 'Events/_EVENT_TIME_RANGE'].forEach(function (pair) {
			if (prefix === pair.split('/')[0] || prefix === pair) {
				var a = state.byPath[pair + '/0'], b = state.byPath[pair + '/1'];
				if (a && b && current(a) > current(b)) warnings.push(pair.split('/')[1] + ': minimum is above maximum');
			}
		});
		var min = state.byPath[prefix + '/min'], max = state.byPath[prefix + '/max'];
		if (min && max && current(min) > current(max)) warnings.push('min is above max');
		return warnings;
	}

	// ---------- rendering ----------

	function renderRow(p) {
		var v = current(p), unit = unitOf(p), meta = META[p.path];
		var row = el('div', { className: 'row', 'data-path': p.path });
		var hint = hintOf(p);
		var name = el('label', { className: 'name', for: 'f:' + p.path }, [displayName(p) + ' ']);
		if (unit && unit !== 'prob') name.appendChild(el('span', { className: 'unit', text: unit }));
		var hintEl = el('span', { className: 'hint' });
		name.appendChild(hintEl);
		var input = el('input', {
			id: 'f:' + p.path, type: 'number', inputmode: 'decimal',
			step: unit === 'prob' ? '0.01' : (Number.isInteger(p.value) ? '1' : 'any'),
			value: String(v), title: p.path
		});
		var reset = el('button', { type: 'button', className: 'reset', title: 'reset to default (' + p.value + ')', 'aria-label': 'reset ' + displayName(p) + ' to default' });
		reset.textContent = '↺';
		row.appendChild(name);
		row.appendChild(input);
		row.appendChild(reset);

		function refresh() {
			var val = current(p);
			var modified = p.path in state.draft;
			row.classList.toggle('modified', modified);
			var warn = fieldWarning(p, val);
			row.classList.toggle('invalid', !!warn);
			var bits = [];
			if (hint) bits.push(hint);
			var f = friendly(val, unit);
			if (f) bits.push(f);
			hintEl.textContent = bits.join(' · ');
			if (modified) hintEl.appendChild(el('span', { className: 'def', text: (bits.length ? ' · ' : '') + 'default ' + p.value }));
			var w = row.querySelector('.warn');
			if (warn && !w) row.appendChild(el('div', { className: 'warn', text: warn }));
			else if (w && !warn) w.remove();
			else if (w) w.textContent = warn;
		}
		input.addEventListener('input', function () {
			if (input.value === '') return;
			var n = Number(input.value);
			if (!isFinite(n)) return;
			if (n === p.value) delete state.draft[p.path]; else state.draft[p.path] = n;
			refresh();
			refreshGroupWarnings(row.closest('.group'));
			updateStatus();
		});
		input.addEventListener('blur', function () { input.value = String(current(p)); });
		reset.addEventListener('click', function () {
			delete state.draft[p.path];
			input.value = String(p.value);
			refresh();
			refreshGroupWarnings(row.closest('.group'));
			updateStatus();
		});
		row._refresh = function () { input.value = String(current(p)); refresh(); };
		refresh();
		return row;
	}

	function refreshGroupWarnings(group) {
		if (!group) return;
		var box = group.querySelector('.groupWarns');
		box.textContent = '';
		groupWarnings(group.getAttribute('data-prefix')).forEach(function (w) {
			box.appendChild(el('div', { className: 'groupWarn', text: '⚠ ' + w }));
		});
	}

	function renderGroups(params, container, fromIndex) {
		var groups = [], byKey = {};
		params.forEach(function (p) {
			var key = groupSegs(p).join('/');
			if (!byKey[key]) { byKey[key] = { key: key, params: [] }; groups.push(byKey[key]); }
			byKey[key].params.push(p);
		});
		groups.forEach(function (g) {
			var box = el('div', { className: 'group', 'data-prefix': g.key });
			var parts = groupTitle(g.params[0], fromIndex);
			if (parts.length) {
				var t = el('div', { className: 'groupTitle' });
				parts.forEach(function (part, i) {
					if (i) t.appendChild(document.createTextNode(' › '));
					t.appendChild(i === parts.length - 1 ? el('b', { text: part }) : document.createTextNode(part));
				});
				box.appendChild(t);
			}
			box.appendChild(el('div', { className: 'groupWarns' }));
			g.params.forEach(function (p) { box.appendChild(renderRow(p)); });
			container.appendChild(box);
			refreshGroupWarnings(box);
		});
	}

	function countLabel(params) {
		var mod = params.filter(function (p) { return p.path in state.draft; }).length;
		var span = el('span', { className: 'count' }, [params.length + ' ']);
		if (mod) span.appendChild(el('span', { className: 'mod', text: '· ' + mod + ' changed' }));
		return span;
	}

	function renderTree(params) {
		var roots = {}, order = [];
		params.forEach(function (p) {
			var r = segs(p)[0];
			if (!roots[r]) { roots[r] = { sections: {}, order: [], params: [] }; order.push(r); }
			var sk = sectionKey(p), root = roots[r];
			if (!root.sections[sk]) { root.sections[sk] = []; root.order.push(sk); }
			root.sections[sk].push(p);
			root.params.push(p);
		});
		var openState = loadOpenState();
		order.forEach(function (r) {
			var info = ROOTS[r] || [r, ''];
			var rootEl = el('details', { className: 'root' });
			var sum = el('summary', null, [info[0] + ' ', el('span', { className: 'blurb', text: info[1] }), countLabel(roots[r].params)]);
			rootEl.appendChild(sum);
			roots[r].order.forEach(function (sk) {
				var ps = roots[r].sections[sk];
				var sec = el('details', { className: 'section', 'data-key': sk });
				sec.appendChild(el('summary', null, [sectionTitle(sk, ps[0]), countLabel(ps)]));
				var body = el('div');
				sec.appendChild(body);
				var filled = false;
				function fill() {
					if (filled) return;
					filled = true;
					renderGroups(ps, body, sk.split('/').length - (sk.indexOf('·general') !== -1 ? 1 : 0));
				}
				sec.addEventListener('toggle', function () { if (sec.open) fill(); saveOpenState(sk, sec.open); });
				if (openState[sk] || state.view === 'modified') { sec.open = true; fill(); }
				rootEl.appendChild(sec);
			});
			rootEl.addEventListener('toggle', function (e) { if (e.target === rootEl) saveOpenState(r, rootEl.open); });
			if (openState[r] || state.view === 'modified') rootEl.open = true;
			paramsEl.appendChild(rootEl);
		});
	}

	function matches(p, words) {
		var hay = (p.path + ' ' + (p.names || []).join(' ') + ' ' + hintOf(p) + ' ' + displayName(p)).toLowerCase();
		return words.every(function (w) { return hay.indexOf(w) !== -1; });
	}

	var SEARCH_LIMIT = 250;
	function render() {
		paramsEl.textContent = '';
		if (!state.catalog.length) return;
		var list = state.catalog;
		if (state.view === 'modified') list = list.filter(function (p) { return p.path in state.draft; });
		var words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
		if (words.length) {
			list = list.filter(function (p) { return matches(p, words); });
			var box = el('div', { className: 'searchResults' });
			if (!list.length) box.appendChild(el('div', { className: 'empty', text: 'no parameters match.' }));
			renderGroups(list.slice(0, SEARCH_LIMIT), box, 0);
			if (list.length > SEARCH_LIMIT) box.appendChild(el('div', { className: 'more', text: (list.length - SEARCH_LIMIT) + ' more; narrow the search.' }));
			paramsEl.appendChild(box);
			return;
		}
		if (!list.length) {
			paramsEl.appendChild(el('div', { className: 'empty', text: state.view === 'modified' ? 'nothing changed from the defaults yet.' : 'no parameters found.' }));
			return;
		}
		renderTree(list);
	}

	// ---------- persistence of the panel's own UI ----------

	function loadOpenState() {
		try { return JSON.parse(localStorage.getItem('designer.open') || '{}'); } catch (e) { return {}; }
	}
	function saveOpenState(key, open) {
		try {
			var s = loadOpenState();
			if (open) s[key] = 1; else delete s[key];
			localStorage.setItem('designer.open', JSON.stringify(s));
		} catch (e) { /* private mode */ }
	}

	// ---------- status, apply, discard ----------

	function sameOverrides(a, b) {
		var ka = Object.keys(a), kb = Object.keys(b);
		return ka.length === kb.length && ka.every(function (k) { return b[k] === a[k]; });
	}

	function updateStatus(message) {
		var dirty = !sameOverrides(state.draft, state.saved);
		var n = Object.keys(state.draft).length;
		$('#modCount').textContent = n;
		$('#apply').disabled = !dirty;
		$('#discard').disabled = !dirty;
		var status = $('#status');
		status.classList.toggle('dirty', dirty);
		status.textContent = message || (dirty ? 'unapplied edits' : (n ? n + ' override' + (n === 1 ? '' : 's') + ' live' : 'all defaults'));
	}

	function refreshVisibleRows() {
		paramsEl.querySelectorAll('.row').forEach(function (r) { r._refresh(); });
		paramsEl.querySelectorAll('.group').forEach(refreshGroupWarnings);
	}

	function apply() {
		var body = JSON.stringify(state.draft);
		updateStatus('saving…');
		fetch('/api/overrides', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body })
			.then(function (r) { if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || r.status); }); })
			.then(function () {
				state.saved = JSON.parse(body);
				updateStatus('reloading game…');
				frame.contentWindow.location.reload();
			})
			.catch(function (err) { updateStatus('save failed: ' + err.message); });
	}

	function showErrors(errors) {
		var box = $('#errors');
		box.hidden = !errors.length;
		box.textContent = errors.length ? 'overrides the game could not apply: ' + errors.join('; ') : '';
	}

	// The iframe reloads on every apply; take the catalog from its first load only.
	frame.addEventListener('load', function () {
		var d;
		try { d = frame.contentWindow.__designer; } catch (e) { d = null; }
		if (!d) { updateStatus('game loaded without the designer hook'); return; }
		showErrors(d.errors || []);
		if (!state.catalog.length) {
			state.catalog = d.defaults.map(function (p) { return { path: p.path, names: p.names, value: p.value, kind: p.kind }; });
			state.catalog.forEach(function (p) { state.byPath[p.path] = p; });
			state.saved = JSON.parse(JSON.stringify(d.overrides));
			state.draft = JSON.parse(JSON.stringify(d.overrides));
			render();
		}
		updateStatus();
	});

	// ---------- toolbar wiring ----------

	var searchTimer;
	$('#search').addEventListener('input', function (e) {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(function () { state.query = e.target.value.trim(); render(); }, 120);
	});
	document.querySelectorAll('.viewToggle button').forEach(function (b) {
		b.addEventListener('click', function () {
			state.view = b.getAttribute('data-view');
			document.querySelectorAll('.viewToggle button').forEach(function (x) { x.classList.toggle('on', x === b); });
			render();
		});
	});
	$('#apply').addEventListener('click', apply);
	$('#discard').addEventListener('click', function () {
		state.draft = JSON.parse(JSON.stringify(state.saved));
		refreshVisibleRows();
		if (state.view === 'modified') render();
		updateStatus();
	});
	$('#resetAll').addEventListener('click', function () {
		closeMenu();
		if (!confirm('Reset every parameter to its default? Nothing is saved until you apply.')) return;
		state.draft = {};
		render();
		updateStatus();
	});
	$('#newGame').addEventListener('click', function () {
		if (!confirm('Delete the saved game and start over? Prestige data is kept.')) return;
		frame.contentWindow.Engine.deleteSave();
	});
	$('#export').addEventListener('click', function () {
		closeMenu();
		var blob = new Blob([JSON.stringify(state.draft, null, 2) + '\n'], { type: 'application/json' });
		var a = el('a', { href: URL.createObjectURL(blob), download: 'adarkroom-tuning.json' });
		document.body.appendChild(a);
		a.click();
		a.remove();
	});
	$('#import').addEventListener('click', function () { closeMenu(); $('#importFile').click(); });
	$('#importFile').addEventListener('change', function (e) {
		var file = e.target.files[0];
		e.target.value = '';
		if (!file) return;
		file.text().then(function (text) {
			var data = JSON.parse(text), unknown = [];
			var next = {};
			Object.keys(data).forEach(function (k) {
				if (typeof data[k] !== 'number' || !isFinite(data[k])) return;
				if (!state.byPath[k]) unknown.push(k); else if (data[k] !== state.byPath[k].value) next[k] = data[k];
			});
			state.draft = next;
			render();
			updateStatus(unknown.length ? 'imported; ' + unknown.length + ' unknown parameters skipped' : 'imported; apply to use');
		}).catch(function (err) { updateStatus('import failed: ' + err.message); });
	});
	function closeMenu() { $('.menu').open = false; }
	document.addEventListener('click', function (e) { if (!e.target.closest('.menu')) closeMenu(); });
	document.addEventListener('keydown', function (e) {
		if ((e.metaKey || e.ctrlKey) && e.key === 's') {
			e.preventDefault();
			if (!$('#apply').disabled) apply();
		}
	});

	// ---------- resizable split ----------

	var resizer = $('#resizer');
	try {
		var w = localStorage.getItem('designer.width');
		if (w) document.documentElement.style.setProperty('--panel-width', w);
	} catch (e) { /* ignore */ }
	resizer.addEventListener('pointerdown', function (e) {
		resizer.setPointerCapture(e.pointerId);
		resizer.classList.add('dragging');
		frame.style.pointerEvents = 'none';
	});
	resizer.addEventListener('pointermove', function (e) {
		if (!resizer.classList.contains('dragging')) return;
		var width = Math.max(320, Math.min(window.innerWidth - 360, window.innerWidth - e.clientX));
		document.documentElement.style.setProperty('--panel-width', width + 'px');
	});
	resizer.addEventListener('pointerup', function () {
		resizer.classList.remove('dragging');
		frame.style.pointerEvents = '';
		try { localStorage.setItem('designer.width', getComputedStyle(document.documentElement).getPropertyValue('--panel-width').trim()); } catch (e) { /* ignore */ }
	});
})();
