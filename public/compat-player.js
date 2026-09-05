/* Real HLS playback and account synchronization, using iOS 12-compatible syntax. */
(function () {
  'use strict';
  function ready() {
    var old = document.querySelector('.player-shell');
    var playlist = window.PLAYER_PLAYLIST || [];
    if (!old || !playlist.length) return;
    var index = Number(window.PLAYER_START_INDEX) || 0;
    var seasons = window.PLAYER_SEASONS || [];
    var season = window.PLAYER_CURRENT_SEASON || (playlist[0] && playlist[0].season);
    var itemId = window.PLAYER_ITEM_ID;
    var hls = null, generation = 0, lastSent = -1, resume = 0, switching = false, hideTimer;
    var current, requestPending = false, manifestSource = '', qualities = [];
    var csrf = document.querySelector('meta[name="csrf-token"]');
    var csrfParam = document.querySelector('meta[name="csrf-param"]');
    var accountLink = document.querySelector('.nav-avatar a[href^="/users/"]');
    var accountKey = accountLink ? accountLink.getAttribute('href').split('/').pop() : 'local';
    function progressKey(entry) { return 'progress_' + accountKey + '_' + entry.media_id; }
    var icons = {
      play: '<path d="M8 4l14 10L8 24z"/>', pause: '<path d="M9 5v18M19 5v18"/>',
      back: '<path d="M7 8a10 10 0 1 1-2 10M7 3v7H1"/>',
      forward: '<path d="M21 8a10 10 0 1 0 2 10M21 3v7h6"/>',
      volume: '<path d="M3 11h5l6-5v16l-6-5H3zM18 9a7 7 0 0 1 0 10M21 5a12 12 0 0 1 0 18"/>',
      list: '<path d="M9 6h16M9 14h16M9 22h16M2 6h1M2 14h1M2 22h1"/>',
      settings: '<circle cx="14" cy="14" r="4"/><path d="M11 2h6l1 4 4 2 4-1 3 5-3 3v4l-3 3-4-1-2 5h-6l-2-5-4 1-3-5 3-3v-4L2 8l3-5 4 1z"/>',
      fullscreen: '<path d="M3 11V3h8M17 3h8v8M25 17v8h-8M11 25H3v-8"/>',
      airplay: '<path d="M4 20H2V3h24v17h-3M14 16l8 10H6z"/>',
      pip: '<rect x="2" y="4" width="24" height="20" rx="2"/><rect x="13" y="13" width="10" height="8"/>'
    };
    function svg(name) { return '<svg viewBox="0 0 28 28" aria-hidden="true">' + icons[name] + '</svg>'; }
    function button(action, label, icon, cls) { return '<button type="button" data-action="' + action + '" aria-label="' + label + '" title="' + label + '" class="' + (cls || '') + '">' + svg(icon) + '</button>'; }
    function getSetting(key, fallback) { try { var value = localStorage.getItem('kw_' + key); return value === null ? fallback : value; } catch (e) { return fallback; } }
    function setting(key, value) { try { localStorage.setItem('kw_' + key, String(value)); } catch (e) {} }
    var shell = document.createElement('section');
    shell.className = 'kw-player'; shell.setAttribute('aria-label', 'Видеоплеер');
    shell.innerHTML = '<video id="kw-video" playsinline webkit-playsinline preload="none" x-webkit-airplay="allow"></video>' +
      '<div class="kw-title"><img alt=""><div><strong></strong><span></span><small></small></div></div>' +
      '<div class="kw-center">' + button('back', 'Назад 10 сек', 'back') + button('play', 'Воспроизвести', 'play', 'kw-big-play') + button('forward', 'Вперёд 10 сек', 'forward') + '</div>' +
      '<div class="kw-bottom"><input class="kw-seek" aria-label="Позиция воспроизведения" type="range" min="0" max="100" step="0.1" value="0"><div class="kw-toolbar">' +
      button('play', 'Воспроизвести', 'play') + '<span class="kw-time">0:00 / 0:00</span>' + button('volume', 'Звук', 'volume') + '<div class="kw-spacer"></div>' +
      button('episodes', 'Список эпизодов', 'list') + button('settings', 'Настройки', 'settings') + button('airplay', 'AirPlay', 'airplay') + button('pip', 'Картинка в картинке', 'pip') + button('fullscreen', 'Во весь экран', 'fullscreen') + '</div></div>' +
      '<div class="kw-panel" hidden></div><div class="kw-error" role="status" hidden><p></p><button type="button" data-action="retry">Повторить</button></div>';
    old.parentNode.replaceChild(shell, old);
    var video = shell.querySelector('video'), panel = shell.querySelector('.kw-panel'), seek = shell.querySelector('.kw-seek'), errorBox = shell.querySelector('.kw-error');
    // Chromium can advertise native HLS without exposing alternate tracks.
    // Use Safari's native path; use hls.js on desktop browsers with MSE.
    var isNative = !!video.canPlayType('application/vnd.apple.mpegurl') && ('audioTracks' in video || /iPad|iPhone|iPod/.test(navigator.userAgent));
    if (!video.webkitShowPlaybackTargetPicker) shell.querySelector('[data-action="airplay"]').hidden = true;
    if (!video.requestPictureInPicture && !video.webkitSetPresentationMode) shell.querySelector('[data-action="pip"]').hidden = true;
    function format(value) { value = Math.max(0, Math.floor(Number(value) || 0)); return (value >= 3600 ? Math.floor(value / 3600) + ':' : '') + (value >= 3600 ? ('0' + Math.floor(value / 60) % 60).slice(-2) : Math.floor(value / 60)) + ':' + ('0' + value % 60).slice(-2); }
    function message(text) { errorBox.querySelector('p').textContent = text; errorBox.hidden = false; shell.classList.remove('kw-playing'); }
    function post(path, fields, beacon) {
      if (csrf) fields[csrfParam ? csrfParam.content : '_csrf'] = csrf.content;
      var body = Object.keys(fields).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(fields[key]); }).join('&');
      if (beacon && navigator.sendBeacon) { navigator.sendBeacon(path, new Blob([body], { type: 'application/x-www-form-urlencoded' })); return Promise.resolve(); }
      return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrf ? csrf.content : '' }, body: body }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text().then(function (text) {
          var data; try { data = JSON.parse(text); } catch (e) { return; }
          if (data && data.success === false) throw new Error('Save rejected');
        });
      });
    }
    function saveProgress(beacon) {
      var time = Math.floor(video.currentTime || 0);
      if (switching || !current || !current.media_id || time < 60 || Math.abs(time - lastSent) < 10) return;
      lastSent = time; current.marktime = time;
      setting(progressKey(current), time);
      post('/item/media-marktime', { media_id: current.media_id, time: time }, beacon).catch(function () { lastSent = -1; });
    }
    function complete(entry, done) {
      return post('/item/update-watching', { media_id: entry.media_id, c: done ? 1 : 0 }).then(function () { entry.completed = done ? 1 : 0; if (done) setting(progressKey(entry), 0); });
    }
    function updateUI() {
      var total = isFinite(video.duration) && video.duration > 0 ? video.duration : (current ? current.duration : 0);
      seek.max = total || 100; seek.value = video.currentTime || 0;
      seek.style.background = 'linear-gradient(to right,#20ce91 ' + (total ? video.currentTime / total * 100 : 0) + '%,#53616a 0%)';
      shell.querySelector('.kw-time').textContent = format(video.currentTime) + ' / ' + format(total);
      var buttons = shell.querySelectorAll('[data-action="play"]');
      for (var i = 0; i < buttons.length; i++) { buttons[i].innerHTML = svg(video.paused ? 'play' : 'pause'); buttons[i].setAttribute('aria-label', video.paused ? 'Воспроизвести' : 'Пауза'); }
      shell.classList.toggle('kw-playing', !video.paused);
    }
    function showControls() {
      shell.classList.remove('kw-hide-controls'); clearTimeout(hideTimer);
      if (!video.paused && panel.hidden) hideTimer = setTimeout(function () { shell.classList.add('kw-hide-controls'); }, 3000);
    }
    function play() {
      errorBox.hidden = true;
      var result = video.play();
      if (result && result.catch) result.catch(function (error) { if (error.name !== 'AbortError') message('Нажмите воспроизведение, чтобы начать просмотр.'); });
    }
    function restoreTracks() {
      var audio = Number(getSetting('audio', '-1')), sub = Number(getSetting('subtitles', '-1'));
      if (hls) {
        if (audio >= 0 && audio < hls.audioTracks.length) hls.audioTrack = audio;
        if (sub >= -1 && sub < hls.subtitleTracks.length) hls.subtitleTrack = sub;
      } else {
        if (video.audioTracks && audio >= 0 && audio < video.audioTracks.length) for (var a = 0; a < video.audioTracks.length; a++) video.audioTracks[a].enabled = a === audio;
        if (sub >= -1 && sub < video.textTracks.length) for (var s = 0; s < video.textTracks.length; s++) video.textTracks[s].mode = s === sub ? 'showing' : 'disabled';
      }
    }
    function load(entry, auto) {
      if (!entry) return;
      saveProgress(); switching = true; generation++; var thisLoad = generation;
      video.pause(); if (hls) { hls.destroy(); hls = null; }
      current = entry; lastSent = -1; resume = Number(entry.marktime) || Number(getSetting(progressKey(entry), '0')) || 0;
      if (Number(entry.completed) === 1) resume = 0;
      video.removeAttribute('src'); video.load();
      errorBox.hidden = true; shell.classList.remove('kw-hide-controls'); shell.classList.remove('kw-started');
      var title = (entry.title || '').split(' / ');
      shell.querySelector('.kw-title strong').textContent = title[0];
      shell.querySelector('.kw-title span').textContent = title.slice(1).join(' / ');
      shell.querySelector('.kw-title small').textContent = (entry.year || entry.yeaer || '') + ' · S' + ('0' + entry.season).slice(-2) + 'E' + ('0' + entry.episode).slice(-2) + (entry.episode_title ? ' · ' + entry.episode_title : '');
      shell.querySelector('.kw-title img').src = entry.poster || '';
      video.poster = entry.thumb || entry.poster || '';
      manifestSource = entry.manifest || entry.src;
      if (!manifestSource) { switching = false; message('Видео недоступно. Выберите другой эпизод.'); return; }
      if (isNative) {
        var source = new URL(manifestSource, location.href), preferredQuality = getSetting('quality_native', '-1');
        if (preferredQuality !== '-1') source.searchParams.set('__quality', preferredQuality);
        video.src = source.href;
      }
      else if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls({ enableWorker: true, maxBufferLength: 30 });
        hls.loadSource(manifestSource); hls.attachMedia(video);
        hls.on(window.Hls.Events.MANIFEST_PARSED, restoreTracks);
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
          var level = Number(getSetting('quality_hls', '-1'));
          if (level >= -1 && level < hls.levels.length) hls.currentLevel = level;
        });
        hls.on(window.Hls.Events.ERROR, function (event, data) { if (data.fatal && thisLoad === generation) message('Не удалось загрузить видео. Проверьте подключение и повторите попытку.'); });
      } else { video.src = manifestSource; video.controls = true; }
      video.playbackRate = Number(getSetting('speed', '1'));
      switching = false;
      try { history.replaceState(null, '', '/item/view/' + encodeURIComponent(itemId) + '/s' + entry.season + 'e' + entry.episode + location.search); } catch (e) {}
      updateUI();
      fetch(manifestSource, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error(); return r.text(); }).then(function (text) {
        if (thisLoad !== generation) return;
        qualities = []; var re = /#EXT-X-STREAM-INF:([^\n]+)/g, match;
        while ((match = re.exec(text))) { var bandwidth = /(?:^|,)BANDWIDTH=(\d+)/.exec(match[1]); var resolution = /RESOLUTION=(\d+)x(\d+)/.exec(match[1]); if (bandwidth && resolution) qualities.push({ value: bandwidth[1], text: resolution[1] + ' × ' + resolution[2] }); }
      }).catch(function () {});
      if (auto) play();
    }
    function next(direction) {
      var nextIndex = index + direction;
      if (nextIndex >= 0 && nextIndex < playlist.length) { index = nextIndex; load(playlist[index], true); return; }
      var pos = -1; seasons.forEach(function (s, i) { if (Number(s.season) === Number(season)) pos = i; });
      if (seasons[pos + direction]) changeSeason(seasons[pos + direction].season, direction < 0 ? -1 : 0, true);
    }
    function changeSeason(number, start, auto) {
      if (requestPending) return;
      requestPending = true;
      fetch('/item/playlist?id=' + encodeURIComponent(itemId) + '&season=' + encodeURIComponent(number), { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error(); return r.json(); }).then(function (data) {
        if (!data.success || !Array.isArray(data.episodes) || !data.episodes.length) throw new Error();
        saveProgress(); playlist = data.episodes; season = number;
        index = start === -1 ? playlist.length - 1 : (typeof start === 'number' ? start : data.firstUnwatchedIndex || 0);
        load(playlist[index], auto); episodePanel();
      }).catch(function () { message('Не удалось загрузить сезон. Повторите попытку.'); }).then(function () { requestPending = false; });
    }
    function panelTitle(title) {
      panel.innerHTML = '<button type="button" class="kw-close" aria-label="Закрыть">×</button><h3></h3>';
      panel.querySelector('h3').textContent = title;
      panel.querySelector('button').onclick = function () { panel.hidden = true; showControls(); };
      panel.hidden = false; showControls();
    }
    function selectControl(label, options, value, onChange) {
      var wrapper = document.createElement('label'); wrapper.className = 'kw-setting';
      var text = document.createElement('span'); text.textContent = label; wrapper.appendChild(text);
      var select = document.createElement('select'); select.setAttribute('aria-label', label);
      options.forEach(function (option) { var node = document.createElement('option'); node.value = option.value; node.textContent = option.text; select.appendChild(node); });
      select.value = String(value); select.onchange = function () { onChange(select.value); };
      wrapper.appendChild(select); panel.appendChild(wrapper); return select;
    }
    function episodePanel() {
      panelTitle('Эпизоды');
      if (seasons.length) selectControl('Сезон', seasons.map(function (s) { return { value: s.season, text: 'Сезон ' + s.season + ' · ' + s.count + ' эп.' }; }), season, function (s) { changeSeason(Number(s), undefined, false); });
      var seasonInfo = seasons.filter(function (s) { return Number(s.season) === Number(season); })[0];
      if (seasonInfo) {
        var all = document.createElement('button'); all.type = 'button'; all.className = 'kw-season-watched';
        all.textContent = seasonInfo.allWatched ? 'Сезон просмотрен ✓' : 'Я видел сезон';
        all.onclick = function () {
          all.disabled = true; var done = !seasonInfo.allWatched;
          post('/item/update-watching', { season_id: seasonInfo.season_id, c: done ? 1 : 0 }).then(function () { seasonInfo.allWatched = done; playlist.forEach(function (p) { p.completed = done ? 1 : 0; }); episodePanel(); }).catch(function () { all.disabled = false; message('Не удалось сохранить отметку сезона.'); });
        }; panel.appendChild(all);
      }
      playlist.forEach(function (entry, position) {
        var row = document.createElement('div'); row.className = 'kw-episode' + (position === index ? ' kw-active' : '');
        var open = document.createElement('button'); open.type = 'button';
        var img = document.createElement('img'); img.src = entry.thumb || entry.poster || ''; img.alt = ''; open.appendChild(img);
        var label = document.createElement('span'); label.textContent = 'S' + ('0' + entry.season).slice(-2) + 'E' + ('0' + entry.episode).slice(-2) + ' · ' + (entry.episode_title || entry.title); open.appendChild(label);
        var duration = document.createElement('small'); duration.textContent = format(entry.duration); label.appendChild(duration);
        open.onclick = function () { index = position; load(entry, true); panel.hidden = true; }; row.appendChild(open);
        var watched = document.createElement('button'); watched.type = 'button'; watched.className = 'kw-watched'; watched.textContent = Number(entry.completed) === 1 ? '✓' : '○'; watched.setAttribute('aria-label', (Number(entry.completed) === 1 ? 'Отметить непросмотренным' : 'Отметить просмотренным') + ' — эпизод ' + entry.episode);
        watched.onclick = function () { watched.disabled = true; complete(entry, Number(entry.completed) !== 1).then(episodePanel).catch(function () { watched.disabled = false; message('Не удалось сохранить отметку эпизода.'); }); }; row.appendChild(watched); panel.appendChild(row);
      });
    }
    function settingsPanel() {
      panelTitle('Настройки');
      selectControl('Скорость', [0.5,0.75,1,1.25,1.5,1.75,2].map(function (s) { return { value: s, text: s + '×' }; }), video.playbackRate, function (s) { video.playbackRate = Number(s); setting('speed', s); });
      selectControl('Следующий эпизод', [{ value: '1', text: 'Автоматически' }, { value: '0', text: 'Вручную' }], getSetting('autoplay', '1'), function (s) { setting('autoplay', s); });
      var levels = hls ? hls.levels.map(function (l, i) { return { value: i, text: l.width + ' × ' + l.height }; }) : qualities;
      if (levels.length) selectControl('Качество', [{ value: '-1', text: 'Авто' }].concat(levels), hls ? hls.currentLevel : getSetting('quality_native', '-1'), function (s) {
        if (hls) hls.currentLevel = Number(s);
        else {
          var u = new URL(manifestSource, location.href); if (s !== '-1') u.searchParams.set('__quality', s); else u.searchParams.delete('__quality');
          resume = video.currentTime; var wasPlaying = !video.paused; video.src = u.href; if (wasPlaying) play();
        }
        setting(hls ? 'quality_hls' : 'quality_native', s);
      });
      var audio = [], audioIndex = -1;
      if (hls) { audio = hls.audioTracks.map(function (t, i) { return { value: i, text: t.name || t.lang || 'Аудио ' + (i + 1) }; }); audioIndex = hls.audioTrack; }
      else if (video.audioTracks) { for (var i = 0; i < video.audioTracks.length; i++) { var a = video.audioTracks[i]; audio.push({ value: i, text: a.label || a.language || 'Аудио ' + (i + 1) }); if (a.enabled) audioIndex = i; } }
      if (audio.length) selectControl('Аудио', audio, audioIndex, function (s) { if (hls) hls.audioTrack = Number(s); else for (var j = 0; j < video.audioTracks.length; j++) video.audioTracks[j].enabled = j === Number(s); setting('audio', s); });
      var subtitles = [{ value: '-1', text: 'Выключены' }], subtitleIndex = -1;
      if (hls) { hls.subtitleTracks.forEach(function (t, i) { subtitles.push({ value: i, text: t.name || t.lang }); }); subtitleIndex = hls.subtitleTrack; }
      else for (var j = 0; j < video.textTracks.length; j++) { var t = video.textTracks[j]; if (t.kind === 'subtitles' || t.kind === 'captions') { subtitles.push({ value: j, text: t.label || t.language || 'Субтитры ' + (j + 1) }); if (t.mode === 'showing') subtitleIndex = j; } }
      selectControl('Субтитры', subtitles, subtitleIndex, function (s) { if (hls) hls.subtitleTrack = Number(s); else for (var k = 0; k < video.textTracks.length; k++) video.textTracks[k].mode = k === Number(s) ? 'showing' : 'disabled'; setting('subtitles', s); });
      if (!audio.length) { var info = document.createElement('p'); info.textContent = 'Аудиодорожки появятся после начала воспроизведения.'; panel.appendChild(info); }
    }
    shell.addEventListener('click', function (event) {
      var target = event.target.closest('[data-action]'); if (!target) { showControls(); return; }
      var action = target.getAttribute('data-action');
      if (action === 'play') { if (video.paused) play(); else video.pause(); }
      else if (action === 'back' || action === 'forward') video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (action === 'back' ? -10 : 10)));
      else if (action === 'volume') { video.muted = !video.muted; target.setAttribute('aria-label', video.muted ? 'Включить звук' : 'Выключить звук'); target.style.opacity = video.muted ? '0.4' : '1'; }
      else if (action === 'episodes') episodePanel();
      else if (action === 'settings') settingsPanel();
      else if (action === 'airplay' && video.webkitShowPlaybackTargetPicker) video.webkitShowPlaybackTargetPicker();
      else if (action === 'fullscreen') {
        if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
        else if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
        else if (shell.requestFullscreen) shell.requestFullscreen();
      } else if (action === 'pip') {
        if (video.webkitSetPresentationMode) video.webkitSetPresentationMode('picture-in-picture');
        else if (video.requestPictureInPicture) video.requestPictureInPicture().catch(function () {});
      } else if (action === 'retry') load(current, true);
      showControls();
    });
    seek.addEventListener('input', function () { if (video.readyState) video.currentTime = Number(seek.value); updateUI(); showControls(); });
    video.addEventListener('loadedmetadata', function () { if (resume > 0 && resume < video.duration - 3) { video.currentTime = resume; } resume = 0; restoreTracks(); updateUI(); });
    video.addEventListener('timeupdate', function () { updateUI(); saveProgress(); });
    video.addEventListener('play', function () { updateUI(); showControls(); });
    video.addEventListener('pause', function () { updateUI(); saveProgress(); showControls(); });
    video.addEventListener('playing', function () { errorBox.hidden = true; shell.classList.add('kw-started'); });
    video.addEventListener('error', function () { if (!switching && video.error) message('Не удалось воспроизвести видео. Повторите попытку или выберите другой эпизод.'); });
    video.addEventListener('ended', function () { complete(current, true).catch(function () {}); if (getSetting('autoplay', '1') === '1') next(1); });
    shell.addEventListener('mousemove', showControls);
    shell.addEventListener('touchstart', showControls, { passive: true });
    document.addEventListener('visibilitychange', function () { if (document.hidden) saveProgress(true); });
    window.addEventListener('pagehide', function () { saveProgress(true); });
    document.addEventListener('keydown', function (event) {
      if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable) return;
      if (event.key === 'Escape') { panel.hidden = true; showControls(); }
      if (event.key === ' ' && shell.contains(document.activeElement)) { event.preventDefault(); if (video.paused) play(); else video.pause(); }
    });
    // Site season links remain ordinary working navigation. Its trailer needs no
    // modern video.js runtime on iOS: Safari can play it directly.
    var trailers = document.querySelectorAll('video:not(#kw-video)');
    for (var n = 0; n < trailers.length; n++) { trailers[n].controls = true; trailers[n].setAttribute('playsinline', ''); }
    load(playlist[index] || playlist[0], false);
    window.kinoCompatPlayer = { video: video, openEpisodes: episodePanel, openSettings: settingsPanel };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
}());
