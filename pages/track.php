<?php
// Цей файл включається в Manager.php, тому сесія та $db, $db2 вже доступні

// Отримуємо Mapbox API ключ
$mapboxApiKey = '';
$mapboxApiFile = '/etc/AdvertismentManager/MapboxAPI.json';
if (file_exists($mapboxApiFile)) {
   $apiData = json_decode(file_get_contents($mapboxApiFile), true);
   $mapboxApiKey = $apiData['api_key'] ?? '';
}
?>

<link rel="stylesheet" href="assets/css/track.css">

<div class="track-container">

   <!-- ═══════════════ TOP: IMEI + дата + інфо + стиль карти ═══════════════ -->
   <div class="track-header">
      <div class="track-header-group">
         <label class="track-label" for="trackImei">IMEI</label>
         <input type="text" id="trackImei" class="input track-input-imei" placeholder="Введіть IMEI трекера">
      </div>

      <div class="track-header-group">
         <label class="track-label" for="trackDate">Дата</label>
         <input type="date" id="trackDate" class="input track-input-date">
      </div>

      <button class="btn" id="trackLoadBtn">
         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
         </svg>
         Завантажити
      </button>

      <div class="track-header-spacer"></div>

      <!-- Інфо про поточну точку -->
      <div class="track-info-bar" id="trackInfoBar">
         <span class="track-info-item" id="trackInfoTime">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <circle cx="12" cy="12" r="10" />
               <path d="M12 6v6l4 2" />
            </svg>
            --:--:--
         </span>
         <span class="track-info-item" id="trackInfoSpeed">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <path d="M12 2L2 7l10 5 10-5-10-5z" />
               <path d="M2 17l10 5 10-5" />
            </svg>
            0 км/г
         </span>
         <span class="track-info-item" id="trackInfoCoords">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
               <circle cx="12" cy="10" r="3" />
            </svg>
            —
         </span>
      </div>

      <div class="track-header-group">
         <select id="trackMapStyle" class="toolbar-select">
            <option value="streets-v12">Вулиці</option>
            <option value="satellite-streets-v12">Супутник</option>
         </select>
      </div>
   </div>

   <!-- ═══════════════ CENTER: карта + табло ═══════════════ -->
   <div class="track-map-wrapper">
      <!-- Карта -->
      <div id="trackMap" class="track-map">
         <div class="track-map-placeholder">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
               <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
               <circle cx="12" cy="10" r="3" />
            </svg>
            <p>Введіть IMEI та дату для завантаження треку</p>
         </div>
      </div>

      <!-- Табло (бічна панель, ~40% карти) -->
      <aside class="track-display-panel" id="trackDisplayPanel" style="display: none;">
         <div class="track-display-header">
            <span class="track-display-title" id="trackDisplayTitle">Табло — перегляд</span>
            <button class="btn-icon track-display-close" id="trackDisplayClose" title="Сховати табло">
               <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12" />
               </svg>
            </button>
         </div>

         <div class="track-display-body">
            <div class="track-display-player-view" id="trackDisplayView">
               <div class="display-additional-info">
                  <div class="display-time" id="displayTimeNow">--:--</div>
               </div>

               <div class="display-route-container" id="displayRouteContainer">
                  <div class="display-empty-hint">
                     Завантажте трек для перегляду табло
                  </div>
               </div>

               <div class="display-ad-container" id="displayAdContainer" style="display: none;">
                  <video id="displayAdVideo" playsinline webkit-playsinline muted preload="auto" loop></video>
                  <img id="displayAdImage" alt="" style="display: none;" />
               </div>

               <div class="display-log" id="displayLog">
                  <div class="display-log-title">Майбутні зупинки:</div>
                  <div class="display-log-list" id="displayLogFuture"></div>
               </div>
            </div>
         </div>
      </aside>
   </div>

   <!-- ═══════════════ BOTTOM: плеєр треку + кнопка табло ═══════════════ -->
   <div class="track-bottom">

      <!-- Плеєр треку -->
      <div class="track-player">
         <!-- Кнопки керування -->
         <div class="track-player-controls">
            <button class="track-player-btn" id="trackPlayBtn" title="Відтворити / Пауза">
               <svg id="trackPlayIcon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5,3 19,12 5,21" />
               </svg>
               <svg id="trackPauseIcon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="display:none;">
                  <rect x="6" y="4" width="4" height="16" />
                  <rect x="14" y="4" width="4" height="16" />
               </svg>
            </button>
         </div>

         <!-- Час поточної точки -->
         <div class="track-player-time" id="trackPlayerTimeStart">00:00:00</div>

         <!-- Шкала прогресу -->
         <div class="track-player-progress-wrapper" id="trackProgressWrapper">
            <div class="track-player-progress-bg">
               <div class="track-player-progress-fill" id="trackProgressFill"></div>
               <div class="track-player-progress-handle" id="trackProgressHandle"></div>
            </div>

            <!-- Мітки зупинок на шкалі -->
            <div class="track-player-stops" id="trackPlayerStops">
               <!-- Тут JS буде малювати мітки зупинок -->
            </div>
         </div>

         <!-- Кінцевий час -->
         <div class="track-player-time" id="trackPlayerTimeEnd">00:00:00</div>

         <!-- Швидкість відтворення -->
         <div class="track-player-speed">
            <button class="track-speed-btn" id="trackSpeedBtn" title="Швидкість відтворення">1x</button>
         </div>

         <!-- Кнопка табло -->
         <div class="track-player-display-toggle">
            <button class="track-player-btn track-display-btn" id="trackDisplayBtn" title="Показати табло">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
               </svg>
            </button>
         </div>
      </div>
   </div>

</div>

<!-- Mapbox GL JS -->
<?php if ($mapboxApiKey): ?>
   <link href="https://api.mapbox.com/mapbox-gl-js/v3.4.0/mapbox-gl.css" rel="stylesheet">
   <script src="https://api.mapbox.com/mapbox-gl-js/v3.4.0/mapbox-gl.js"></script>

   <script>
      window.MAPBOX_API_KEY = <?= json_encode($mapboxApiKey) ?>;
   </script>
   <script src="assets/js/track.js"></script>
<?php else: ?>
   <script>
      console.error('Mapbox API key not found!');
      document.getElementById('trackMap').innerHTML =
         '<div class="track-map-placeholder" style="color:#ff6b6b;">Mapbox API ключ не знайдено. Перевірте файл /etc/AdvertismentManager/MapboxAPI.json</div>';
   </script>
<?php endif; ?>