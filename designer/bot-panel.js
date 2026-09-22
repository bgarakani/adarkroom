/**
 * Bot tab of the designer panel: drives window.__bot inside the game iframe,
 * shows its live trace and the pacing milestones, and lists saved runs.
 */
(function () {
	'use strict';

	var POLL_MS = 500;
	var MAX_ROWS = 600;
	var CATEGORIES = [
		['actions', 'actions', /^action$/],
		['events', 'events', /^event\./],
		['combat', 'combat', /^combat\./],
		['world', 'world', /^(world\.|trip\.|death)/],
		['notes', 'game text', /^notify$/],
		['state', 'state', /^(snapshot|milestone|run\.|space\.|game\.|bot\.)/]
	];

	var $ = function (sel) { return document.querySelector(sel); };
	var frame = $('#game');
	var list = $('#traceList');
	var lastSeq = 0, lastRun = null, lastMilestones = -1;

	function bot() {
		try { return frame.contentWindow.__bot || null; } catch (e) { return null; }
	}

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}

	function clock(ms) {
		var s = Math.floor((ms || 0) / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
		s %= 60;
		var pad = function (n) { return (n < 10 ? '0' : '') + n; };
		return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
	}

	// ---------- tabs ----------

	function showTab(name) {
		var bot = name === 'bot';
		$('#tabTuning').setAttribute('aria-selected', String(!bot));
		$('#tabBot').setAttribute('aria-selected', String(bot));
		$('#tuningTools').hidden = bot;
		$('#params').hidden = bot;
		$('#botTools').hidden = !bot;
		$('#botView').hidden = !bot;
		try { localStorage.setItem('designer.tab', name); } catch (e) { /* ignore */ }
		if (bot) loadRuns();
	}
	$('#tabTuning').addEventListener('click', function () { showTab('tuning'); });
	$('#tabBot').addEventListener('click', function () { showTab('bot'); });

	// ---------- trace filters ----------

	var hidden = {};
	try { hidden = JSON.parse(localStorage.getItem('designer.traceHidden') || '{"notes":1}'); } catch (e) { hidden = {}; }
	CATEGORIES.forEach(function (c) {
		var b = el('button', hidden[c[0]] ? '' : 'on', c[1]);
		b.type = 'button';
		b.setAttribute('aria-pressed', String(!hidden[c[0]]));
		b.addEventListener('click', function () {
			if (hidden[c[0]]) delete hidden[c[0]]; else hidden[c[0]] = 1;
			b.classList.toggle('on', !hidden[c[0]]);
			b.setAttribute('aria-pressed', String(!hidden[c[0]]));
			try { localStorage.setItem('designer.traceHidden', JSON.stringify(hidden)); } catch (e) { /* ignore */ }
			applyFilters();
		});
		$('#traceFilters').appendChild(b);
	});
	function categoryOf(type) {
		for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i][2].test(type)) return CATEGORIES[i][0];
		return 'state';
	}
	function applyFilters() {
		list.querySelectorAll('li').forEach(function (li) { li.hidden = !!hidden[li.dataset.cat]; });
	}

	// ---------- rendering trace entries ----------

	function deltaText(d) {
		return Object.keys(d || {}).map(function (k) { return (d[k] > 0 ? '+' : '') + d[k] + ' ' + k; }).join(', ');
	}

	function summary(e) {
		switch (e.type) {
			case 'action':
				return [e.action + (e.target ? ' ' + e.target : ''), e.reason, deltaText(e.delta)];
			case 'event.start': return ['event: ' + e.title, e.at ? 'at ' + e.at : ''];
			case 'event.scene': return ['scene ' + e.scene, e.title];
			case 'event.choice': return ['chose ' + e.choice, e.reason];
			case 'event.end': return ['event over'];
			case 'combat.hit':
				return [(e.attacker === 'enemy' ? 'enemy hits' : 'wanderer hits') + ' for ' + e.dmg, 'target hp ' + e.targetHp + ' · player hp ' + e.playerHp];
			case 'world.move':
				return ['move ' + (e.pos || []).join(',') + ' ' + (e.tile || ''), 'hp ' + e.hp + '/' + e.maxHp + ' · water ' + e.water + ' · meat ' + e.meat + ' · ' + e.home + ' from home'];
			case 'world.goal': return ['goal ' + (e.goal || []).join(','), e.why];
			case 'world.stuck': return ['no route to ' + (e.goal || []).join(',')];
			case 'trip.start': return ['expedition starts', JSON.stringify(e.outfit)];
			case 'trip.end': return ['expedition ends: ' + e.how, clock(e.duration) + ' out'];
			case 'death': return ['died', 'at ' + (e.pos || []).join(',') + ', ' + e.home + ' from home'];
			case 'notify': return [e.text];
			case 'milestone': return ['milestone: ' + e.what];
			case 'snapshot':
				var st = e.stores || {};
				return ['snapshot (' + e.why + ')', 'pop ' + e.population + ' · ' + Object.keys(st).slice(0, 8).map(function (k) { return Math.floor(st[k]) + ' ' + k; }).join(', ')];
			case 'space.steer': return ['steer ' + e.dir, 'x ' + e.x + ' · altitude ' + e.altitude + ' · hull ' + e.hull];
			case 'space.hull': return ['hull hit', 'hull ' + e.hull + ' · altitude ' + e.altitude];
			case 'space.crash': return ['ship crashed', 'altitude ' + e.altitude];
			case 'game.win': return ['game won', clock(e.elapsed)];
			case 'run.start': return ['run started' + (e.fresh ? ' (fresh game)' : ''), 'speed ' + e.warp + '× · ' + Object.keys(e.overrides || {}).length + ' tuning overrides'];
			case 'run.resume': return ['run resumed after reload', 'speed ' + e.warp + '× · ' + Object.keys(e.overrides || {}).length + ' tuning overrides'];
			case 'run.stop': return ['run stopped', e.why];
			case 'run.warp': return ['speed ' + e.warp + '×'];
			case 'run.stall': return ['browser throttled the tab', 'skipped ' + clock(e.lostGameMs) + ' of game time' + (e.hidden ? ' (tab hidden)' : '')];
			case 'bot.error': return ['bot error', e.message];
			default: return [e.type, JSON.stringify(e)];
		}
	}

	function renderEntry(e) {
		var cat = categoryOf(e.type);
		var li = el('li', 'entry ' + cat + ' t-' + e.type.replace('.', '-'));
		li.dataset.cat = cat;
		li.hidden = !!hidden[cat];
		var parts = summary(e);
		li.appendChild(el('span', 'time', clock(e.t)));
		var body = el('span', 'what');
		body.appendChild(el('span', 'head', parts[0]));
		for (var i = 1; i < parts.length; i++) if (parts[i]) body.appendChild(el('span', 'detail', parts[i]));
		li.appendChild(body);
		li.title = JSON.stringify(e, null, 1);
		return li;
	}

	function appendEntries(entries) {
		if (!entries.length) return;
		var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
		var frag = document.createDocumentFragment();
		entries.forEach(function (e) { frag.appendChild(renderEntry(e)); });
		list.appendChild(frag);
		while (list.children.length > MAX_ROWS) list.removeChild(list.firstChild);
		if ($('#traceFollow').checked && (atBottom || entries.length)) list.scrollTop = list.scrollHeight;
	}

	// ---------- status ----------

	function renderStatus(s) {
		var dl = $('#botStatus');
		dl.textContent = '';
		function row(k, v) { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v)); }
		row('state', s.running ? 'playing' : (s.runId ? 'stopped' : 'idle'));
		if (s.runId) row('run', s.runId);
		row('game time', clock(s.elapsed) + ' at ' + s.warp + '×');
		row('location', s.module);
		if (s.trip && s.trip.status) {
			var t = s.trip.status;
			row('expedition', 'hp ' + t.hp + '/' + t.maxHp + ' · water ' + t.water + ' · meat ' + t.meat + ' · ' + t.home + ' from home');
		}
		row('doing', s.intent || '—');
		if (s.running && (s.hidden || s.stalled > 5000)) {
			var dd = el('dd', 'stallWarn', s.hidden
				? 'this tab is in the background, so the browser is running the game at a crawl — keep it visible for a true-speed run'
				: 'lost ' + clock(s.stalled) + ' of game time to background throttling; it is excluded from the times above');
			dl.appendChild(el('dt', 'stallWarn', '⚠ timing'));
			dl.appendChild(dd);
		}
		$('#botStop').disabled = !s.running;
		$('#botFresh').disabled = s.running;
		$('#botResume').disabled = s.running;
		$('#botStep').disabled = s.running;
		var warp = String(s.warp);
		if ($('#botWarp').value !== warp && document.activeElement !== $('#botWarp')) $('#botWarp').value = warp;

		if (s.milestones.length !== lastMilestones) {
			lastMilestones = s.milestones.length;
			var ol = $('#botMilestones');
			ol.textContent = '';
			if (!s.milestones.length) ol.appendChild(el('li', 'empty', 'none yet.'));
			s.milestones.forEach(function (m, i) {
				var li = el('li');
				li.appendChild(el('span', 'time', clock(m.t)));
				li.appendChild(el('span', 'what', m.what));
				if (i) li.appendChild(el('span', 'gap', '+' + clock(m.t - s.milestones[i - 1].t)));
				ol.appendChild(li);
			});
		}
	}

	function poll() {
		var b = bot();
		if (!b) return;
		var s = b.status();
		if (s.runId !== lastRun) {
			lastRun = s.runId;
			lastSeq = 0;
			lastMilestones = -1;
			list.textContent = '';
		}
		appendEntries(b.since(lastSeq).slice(-MAX_ROWS));
		lastSeq = s.seq;
		renderStatus(s);
	}

	// ---------- saved runs ----------

	function loadRuns() {
		fetch('/api/traces').then(function (r) { return r.json(); }).then(function (runs) {
			var ul = $('#botRuns');
			ul.textContent = '';
			if (!runs.length) ul.appendChild(el('li', 'empty', 'no runs yet.'));
			runs.forEach(function (r) {
				var li = el('li');
				var a = el('a', null, r.run);
				a.href = r.url;
				a.download = r.run + '.ndjson';
				li.appendChild(a);
				li.appendChild(el('span', 'detail', (r.bytes / 1024).toFixed(1) + ' KB' + (r.run === lastRun ? ' · current' : '')));
				ul.appendChild(li);
			});
		}).catch(function () { /* server restarting */ });
	}

	// ---------- controls ----------

	$('#botFresh').addEventListener('click', function () {
		var b = bot();
		if (!b) return;
		if (!confirm('Start a fresh run? This deletes the saved game (prestige is kept) and the bot plays from the first fire.')) return;
		b.setWarp(Number($('#botWarp').value));
		b.start({ fresh: true });
	});
	$('#botResume').addEventListener('click', function () {
		var b = bot();
		if (!b) return;
		b.setWarp(Number($('#botWarp').value));
		b.start({});
		poll();
	});
	$('#botStop').addEventListener('click', function () { var b = bot(); if (b) { b.stop(); poll(); loadRuns(); } });
	$('#botStep').addEventListener('click', function () { var b = bot(); if (b) { b.step(); poll(); } });
	$('#botWarp').addEventListener('change', function (e) { var b = bot(); if (b) b.setWarp(Number(e.target.value)); });

	var saved = 'tuning';
	try { saved = localStorage.getItem('designer.tab') || 'tuning'; } catch (e) { /* ignore */ }
	showTab(saved);
	setInterval(poll, POLL_MS);
	setInterval(function () { if (!$('#botView').hidden) loadRuns(); }, 10000);
})();
