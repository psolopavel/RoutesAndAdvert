<?php
// Цей файл включається в Manager.php, тому сесія та $db, $db2, $db3 вже доступні

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
<link rel="stylesheet" href="assets/css/tariffs.css">

<div class="tariffs-container">
   <!-- Ліва половина: список маршрутів та редактор тарифів -->
   <aside class="tariffs-sidebar" id="tariffsSidebar">
      <!-- Режим списку маршрутів -->
      <div id="tariffsListMode">
         <div class="tariffs-header">
            <h3>Тарифи маршрутів</h3>
         </div>
         <div class="tariffs-search">
            <input type="text" id="tariffRouteSearch" class="input" placeholder="Пошук маршруту...">
         </div>
         <div class="tariffs-routes-list" id="tariffsRoutesList">
            <div class="tariffs-loading">Завантаження маршрутів...</div>
         </div>
      </div>

      <!-- Режим редагування тарифів маршруту -->
      <div id="tariffsEditMode" style="display: none;">
         <div class="tariffs-header">
            <button class="btn-icon" id="tariffBackBtn" title="Назад">
               <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
               </svg>
            </button>
            <h3 id="tariffEditTitle">Тарифи маршруту</h3>
            <button class="btn-icon" id="tariffJsonViewBtn" title="Формат тарифів (JSON / TXT)" style="display: none;">
               <img src="assets/images/page.svg" alt="" height="24px" class="tariff-header-icon">
            </button>
         </div>

         <div class="tariff-route-meta" id="tariffRouteMeta"></div>

         <div class="tariffs-edit-content" id="tariffsEditContent">
            <!-- Список тарифів маршруту -->
            <div class="tariff-list-section">
               <div class="section-title">
                  Тарифи маршруту
                  <div class="tariff-list-actions">
                     <button class="btn btn-small" id="addTariffBtn">+ Новий тариф (вписати)</button>
                     <button class="btn btn-small" id="uploadTariffBtn" style="display: none;">+ Новий тариф (файл)</button>
                  </div>
               </div>
               <input type="file" id="tariffFileInput" accept=".json,.txt,application/json,text/plain" style="display: none;">
               <div id="tariffItemsList" class="tariff-items-list">
                  <div class="tariffs-empty">Тарифів ще немає</div>
               </div>
            </div>

            <!-- Форма тарифу -->
            <div class="tariff-form-section" id="tariffFormSection" style="display: none;">
               <div class="section-title">
                  <span id="tariffFormTitle">Новий тариф</span>
                  <span id="tariffAutosaveStatus" class="autosave-status"></span>
               </div>

               <input type="hidden" id="tariffId">

               <div class="form-group">
                  <label for="tariffName">Назва тарифу</label>
                  <input type="text" id="tariffName" class="input" placeholder="ISHKHAN: перший тариф">
               </div>

               <!-- Тариф для міського маршруту: одна ціна -->
               <div id="cityTariffBlock" style="display: none;">
                  <div class="form-group">
                     <label for="cityPrice">Ціна проїзду (грн)</label>
                     <input type="number" id="cityPrice" class="input" min="0" step="0.5" placeholder="20">
                  </div>
                  <p class="tariff-hint">Для міського маршруту діє єдина ціна між будь-якими зупинками.</p>
               </div>

               <!-- Тариф для міжміського маршруту: матриця пар -->
               <div id="intercityTariffBlock" style="display: none;">
                  <div class="form-group">
                     <label for="intercityFromStop">Від зупинки</label>
                     <select id="intercityFromStop" class="input"></select>
                  </div>
                  <p class="tariff-hint">Вкажіть ціну від обраної зупинки до кожної наступної. При фокусі на полі — відповідний відрізок підсвічується на карті.</p>
                  <div id="intercityProgress" class="intercity-progress"></div>
                  <div id="intercityPairsList" class="intercity-pairs-list"></div>
               </div>

               <div class="tariff-form-actions">
                  <button class="btn btn-block" id="saveTariffBtn">Зберегти тариф</button>
                  <button class="btn btn-block btn-secondary" id="cancelTariffBtn">Скасувати</button>
                  <button class="btn btn-block btn-danger" id="deleteTariffBtn" style="display: none;">Видалити тариф</button>
               </div>
            </div>
         </div>
      </div>
   </aside>

   <!-- Права половина: карта -->
   <main class="tariffs-map-container">
      <div id="tariffsMap" class="tariffs-map"></div>
      <div class="tariffs-map-legend" id="tariffsMapLegend" style="display: none;">
         <span class="legend-dot" style="background:#f39c12"></span>
         <span>Активний відрізок тарифу</span>
      </div>
   </main>
</div>

<!-- Модальне вікно: формат JSON тарифів -->
<div class="modal-overlay" id="tariffJsonModal" style="display: none;">
   <div class="modal tariff-json-modal">
      <div class="modal-header">
         <h3>Формат тарифів</h3>
         <div class="tariff-json-modal-actions">
            <div class="tariff-format-toggle" id="tariffFormatToggle">
               <button type="button" class="fmt-btn active" data-fmt="json">JSON</button>
               <button type="button" class="fmt-btn" data-fmt="txt">TXT</button>
            </div>
            <button class="btn-icon" id="tariffJsonDownloadBtn" title="Завантажити файл">
               <img src="assets/images/copy.svg" alt="" width="18" height="18" class="tariff-header-icon">
            </button>
            <button class="btn-icon" id="closeTariffJsonModal" title="Закрити"><img src="assets/images/close.svg" alt="" width="18" height="18" class="tariff-header-icon"></button>
         </div>
      </div>
      <div class="modal-body">
         <p class="tariff-json-hint" id="tariffFormatHint">Заповніть поле <code>price</code> для кожної пари зупинок. Після редагування збережіть файл і завантажте через «Новий тариф (файл)».</p>
         <pre class="tariff-json-view" id="tariffJsonView"></pre>
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
   <script src="assets/js/tariffs.js"></script>
<?php else: ?>
   <script>
      console.error('Mapbox API key not found!');
      document.getElementById('tariffsMap').innerHTML = '<div class="map-error">Mapbox API ключ не знайдено. Перевірте файл /etc/AdvertismentManager/MapboxAPI.json</div>';
   </script>
<?php endif; ?>