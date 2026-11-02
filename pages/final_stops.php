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

<style>
   html {
      overflow: hidden;
   }
</style>
<link rel="stylesheet" href="assets/css/final_stops.css">

<div class="fs-container">
   <!-- Ліва панель: список глобальних зон -->
   <aside class="fs-sidebar">
      <div class="fs-sidebar-header">
         <h3>Глобальні зони</h3>
         <div class="fs-subtitle">Кінцеві зупинки та зони ігнорування підрахунку без прив'язки до маршруту</div>
      </div>

      <div class="fs-sidebar-search">
         <input type="text" id="fsSearch" class="input" placeholder="Пошук за назвою...">
      </div>

      <div class="fs-hint">
         Використовуйте кнопки на панелі інструментів карти, щоб намалювати кругову або полігональну зону.
      </div>

      <!-- Перегляд треку машини (для орієнтування при малюванні зон) -->
      <div class="fs-track-section">
         <div class="fs-track-title">Трек машини</div>
         <div class="fs-track-subtitle">Показати трек на карті, щоб бачити де їздить машина</div>
         <div class="form-group">
            <label for="fsTrackImei">IMEI</label>
            <input type="text" id="fsTrackImei" class="input" placeholder="Введіть IMEI трекера">
         </div>
         <div class="form-group">
            <label for="fsTrackDate">Дата</label>
            <input type="date" id="fsTrackDate" class="input">
         </div>
         <div class="fs-track-actions">
            <button class="btn" id="fsTrackLoadBtn">Показати трек</button>
            <button class="btn btn-secondary" id="fsTrackClearBtn" style="display: none;">Прибрати</button>
         </div>
         <div class="fs-track-status" id="fsTrackStatus"></div>
      </div>

      <div id="fsZonesList" class="fs-zones-list">
         <div class="fs-empty">Завантаження...</div>
      </div>
   </aside>

   <!-- Центральна частина: карта -->
   <main class="fs-map-container">
      <div class="fs-toolbar" id="fsToolbar">
         <div class="toolbar-group">
            <button class="toolbar-btn" id="fsFitBounds" title="Показати всі зони">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
               </svg>
            </button>
         </div>

         <div class="toolbar-divider"></div>

         <div class="toolbar-group">
            <button class="toolbar-btn" id="fsAddCircleBtn" title="Додати кругову зону">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10" />
               </svg>
            </button>
            <button class="toolbar-btn" id="fsAddPolygonBtn" title="Додати полігон">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="12,2 22,22 2,22" />
               </svg>
            </button>
         </div>

         <div class="toolbar-spacer"></div>

         <div class="toolbar-group">
            <select id="fsMapStyleSelect" class="toolbar-select">
               <option value="streets-v12">Вулиці</option>
               <option value="satellite-streets-v12">Супутник</option>
            </select>
         </div>
      </div>

      <div id="fsMap" class="fs-map"></div>

      <div class="fs-statusbar" id="fsStatusbar">
         <span id="fsStatusCoords">—</span>
         <span id="fsStatusMode">Режим: Перегляд</span>
      </div>

      <div id="fsDrawHint" class="fs-draw-hint" style="display: none;"></div>

      <!-- Панель редагування геометрії зони -->
      <div id="fsEditPanel" class="fs-edit-panel" style="display: none;">
         <div class="fs-edit-panel-title">Редагування зони</div>
         <div class="fs-edit-panel-hint">Перетягуйте маркери на карті, щоб змінити форму зони.</div>
         <div class="form-group">
            <label for="fsEditName">Назва зони</label>
            <input type="text" id="fsEditName" class="input" placeholder="Назва зони">
         </div>
         <div class="form-group">
            <label for="fsEditType">Тип зони</label>
            <select id="fsEditType" class="input">
               <option value="final_stop">Кінцева зупинка</option>
               <option value="counting_ignoring">Ігнорування підрахунку</option>
            </select>
         </div>
         <label class="fs-edit-active">
            <input type="checkbox" id="fsEditActive" checked> Активна
         </label>
         <div class="fs-edit-panel-actions">
            <button class="btn" id="fsEditSaveBtn">Зберегти</button>
            <button class="btn btn-secondary" id="fsEditCancelBtn">Скасувати</button>
         </div>
      </div>
   </main>
</div>

<!-- Модальне вікно для збереження зони -->
<div class="modal-overlay" id="fsZoneModal" style="display: none;">
   <div class="modal">
      <div class="modal-header">
         <h3 id="fsZoneModalTitle">Нова глобальна зона</h3>
         <button class="btn-icon" id="fsCloseZoneModal">×</button>
      </div>
      <div class="modal-body">
         <form id="fsZoneForm" onsubmit="return false;">
            <input type="hidden" id="fsZoneId" value="">
            <div class="form-group">
               <label for="fsZoneName">Назва зони</label>
               <input type="text" id="fsZoneName" class="input" required placeholder="Напр: Кінцева зупинка Депо">
            </div>
            <div class="form-group">
               <label for="fsZoneType">Тип зони</label>
               <select id="fsZoneType" class="input">
                  <option value="final_stop">Кінцева зупинка</option>
                  <option value="counting_ignoring">Ігнорування підрахунку</option>
               </select>
            </div>
            <div class="form-group">
               <label>
                  <input type="checkbox" id="fsZoneActive" checked> Активна
               </label>
            </div>
         </form>
      </div>
      <div class="modal-footer">
         <button class="btn" id="fsSaveZoneBtn">Зберегти</button>
         <button class="btn btn-secondary" id="fsCancelZoneBtn">Скасувати</button>
      </div>
   </div>
</div>

<!-- Mapbox GL JS -->
<?php if ($mapboxApiKey): ?>
   <link href="https://api.mapbox.com/mapbox-gl-js/v3.4.0/mapbox-gl.css" rel="stylesheet">
   <script src="https://api.mapbox.com/mapbox-gl-js/v3.4.0/mapbox-gl.js"></script>

   <link href="https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-geocoder/v5.0.2/mapbox-gl-geocoder.css" rel="stylesheet">
   <script src="https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-geocoder/v5.0.2/mapbox-gl-geocoder.min.js"></script>

   <script>
      window.MAPBOX_API_KEY = <?= json_encode($mapboxApiKey) ?>;
   </script>
   <script src="assets/js/final_stops.js"></script>
<?php else: ?>
   <script>
      console.error('Mapbox API key not found!');
      document.getElementById('fsMap').innerHTML = '<div class="map-error">Mapbox API ключ не знайдено. Перевірте файл /etc/AdvertismentManager/MapboxAPI.json</div>';
   </script>
<?php endif; ?>
