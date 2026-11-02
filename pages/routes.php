<?php
// Цей файл включається в Manager.php, тому сесія та $db, $db2 вже доступні

// Отримуємо Mapbox API ключ
$mapboxApiKey = '';
$mapboxApiFile = '/etc/AdvertismentManager/MapboxAPI.json';
if (file_exists($mapboxApiFile)) {
   $apiData = json_decode(file_get_contents($mapboxApiFile), true);
   $mapboxApiKey = $apiData['api_key'] ?? '';
}

// Клієнт лише переглядає призначені йому маршрути
$routesReadonly = authIsClient($currentUser);

// Отримуємо групи маршрутів з БД
$routeGroups = [];
if ($db2) {
   $groupsWhere = $routesReadonly
      ? "WHERE id IN (SELECT group_id FROM routes WHERE id IN (" . authSqlIntList(authUserRouteIds($currentUser)) . "))"
      : "";
   $res = $db2->query("SELECT id, name, additional, created_at FROM route_groups $groupsWhere ORDER BY name");
   if ($res) {
      while ($row = $res->fetch_assoc()) {
         $routeGroups[] = $row;
      }
      $res->free();
   }
}
?>

<style>
   html {
      overflow: hidden;
   }
</style>
<link rel="stylesheet" href="assets/css/routes.css">
<div class="routes-container">
   <!-- Ліва панель -->
   <aside class="routes-sidebar" id="routesSidebar">
      <!-- Режим перегляду списку маршрутів -->
      <div id="sidebarListMode">
         <div class="sidebar-header">
            <h3>Маршрути</h3>
            <?php if (!$routesReadonly): ?>
               <button class="btn-icon" id="addGroupBtn" title="Додати групу">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                     <path d="M12 5v14M5 12h14" />
                  </svg>
               </button>
            <?php endif; ?>
         </div>

         <div class="sidebar-search">
            <input type="text" id="routeSearch" class="input" placeholder="Пошук маршрутів...">
         </div>

         <div class="routes-tree" id="routesTree">
            <?php if (empty($routeGroups)): ?>
               <div class="tree-empty">
                  <?php if ($routesReadonly): ?>
                     <p>Вам ще не призначено маршрутів</p>
                  <?php else: ?>
                     <p>Немає груп маршрутів</p>
                     <button class="btn btn-small" id="createFirstGroup">Створити першу групу</button>
                  <?php endif; ?>
               </div>
            <?php else: ?>
               <?php foreach ($routeGroups as $group): ?>
                  <div class="tree-group" data-group-id="<?= $group['id'] ?>">
                     <div class="tree-group-header">
                        <span class="tree-toggle">▶</span>
                        <span class="tree-group-name"><?= htmlspecialchars($group['name']) ?></span>
                        <?php if (!$routesReadonly): ?>
                           <div class="tree-group-actions">
                              <button class="btn-icon btn-tiny add-route-btn" title="Додати маршрут">+</button>
                              <button class="btn-icon btn-tiny edit-group-btn" title="Редагувати">✎</button>
                           </div>
                        <?php endif; ?>
                     </div>
                     <div class="tree-routes" style="display: none;">
                        <div class="tree-loading">Завантаження...</div>
                     </div>
                  </div>
               <?php endforeach; ?>
            <?php endif; ?>
         </div>
      </div>

      <!-- Режим створення/редагування маршруту -->
      <div id="sidebarEditMode" style="display: none;">
         <div class="sidebar-header">
            <button class="btn-icon" id="backToListBtn" title="Назад">
               <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
               </svg>
            </button>
            <h3 id="editModeTitle">Новий маршрут</h3>
            <div></div>
         </div>

         <div class="sidebar-edit-content">
            <input type="hidden" id="editRouteId">
            <input type="hidden" id="editRouteGroupId">

            <!-- Основні дані -->
            <div class="edit-section">
               <div class="form-group">
                  <label>Назва маршруту</label>
                  <input type="text" id="editRouteName" class="input" placeholder="Напр: Маршрут №15">
               </div>
               <div class="form-group">
                  <label>Колір</label>
                  <input type="color" id="editRouteColor" value="#3388ff">
               </div>
            </div>

            <!-- Зупинки маршруту -->
            <div class="edit-section" id="stopsSection">
               <div class="section-title">
                  Зупинки маршруту
                  <span id="stopsCount" style="font-size: 12px; color: var(--muted);"></span>
               </div>
               <div id="routeStopsList" class="stops-list">
                  <div class="zones-empty">Немає зупинок</div>
               </div>
               <div class="zone-add-hint">
                  <span style="font-size: 11px; color: var(--muted); font-style: italic;">
                     Натисніть кнопку зупинки на тулбарі та клікніть на маршрут. Перетягніть рядки для зміни порядку зупинок.
                  </span>
               </div>
            </div>

            <!-- Зони маршруту -->
            <div class="edit-section" id="zonesSection">
               <div class="section-title">
                  Зони маршруту
                  <span id="zonesCount" style="font-size: 12px; color: var(--muted);"></span>
               </div>

               <div id="zoneDrawHint" class="zone-draw-hint" style="display: none;"></div>

               <div id="routeZonesList" class="zones-list">
                  <div class="zones-empty">Немає зон</div>
               </div>

               <div class="zone-add-hint">
                  <span style="font-size: 11px; color: var(--muted); font-style: italic;">
                     Використовуйте кнопки зон на панелі інструментів карти
                  </span>
               </div>
            </div>

            <!-- Інформація про маршрут -->
            <div class="edit-section">
               <div class="section-title">Інформація про маршрут</div>
               <div id="routeInfo" class="route-info">
                  <div class="route-info-empty">Маршрут ще не побудовано</div>
               </div>
            </div>

            <!-- Точки маршруту (заповнюються через кліки по карті) -->
            <div class="edit-section">
               <div class="section-title">Точки маршруту</div>
               <div id="waypointsList" class="waypoints-list">
                  <div class="route-info-empty">Клікніть на карту для додавання точок</div>
               </div>
            </div>
         </div>

         <!-- Кнопки дій -->
         <div class="sidebar-actions">
            <button class="btn btn-block" id="saveRouteFullBtn">
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
               </svg>
               Зберегти маршрут
            </button>
            <button class="btn btn-block btn-secondary" id="cancelRouteFullBtn">Скасувати</button>
         </div>
      </div>
   </aside>

   <!-- Центральна частина: карта -->
   <main class="routes-map-container">
      <!-- Панель інструментів -->
      <div class="map-toolbar" id="mapToolbar">
         <div class="toolbar-group">
            <button class="toolbar-btn" id="toolFitBounds" title="На весь екран (F)">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
               </svg>
            </button>
         </div>

         <div class="toolbar-group">
            <button class="toolbar-btn" id="toolTraffic" title="Показати трафік">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="6" y="2" width="12" height="20" rx="2" />
                  <circle cx="12" cy="7" r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                  <circle cx="12" cy="17" r="1.5" />
               </svg>
            </button>
            <button class="toolbar-btn" id="tool3d" title="3D будівлі">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
               </svg>
            </button>
            <button class="toolbar-btn" id="toolTransit" title="Тільки зупинки транспорту">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="4" y="3" width="16" height="14" rx="3" />
                  <path d="M4 12h16" />
                  <circle cx="8" cy="20" r="1.5" fill="currentColor" />
                  <circle cx="16" cy="20" r="1.5" fill="currentColor" />
                  <line x1="8" y1="17" x2="8" y2="21" />
                  <line x1="16" y1="17" x2="16" y2="21" />
               </svg>
            </button>
         </div>

         <!-- Edit-mode tools: route draw, undo, zone creation -->
         <div class="toolbar-group toolbar-edit-tools" id="toolbarEditTools" style="display: none;">
            <div class="toolbar-divider"></div>

            <!-- Route drawing mode select -->
            <select class="toolbar-select" id="toolRouteDraw" title="Метод побудови маршруту">
               <option value="">✕ Малювання вимкнено</option>
               <option value="roads">🛣 По дорогах (авто)</option>
               <option value="straight">📐 По прямій (ігн. ПДР)</option>
            </select>
            <button class="toolbar-btn" id="toolUndo" title="Відмінити останню точку (Ctrl+Z)">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
               </svg>
            </button>

            <!-- Stop placement -->
            <button class="toolbar-btn" id="toolAddStop" title="Додати зупинку на маршрут">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" opacity="0.3" />
                  <line x1="12" y1="9" x2="12" y2="15" />
                  <line x1="9" y1="12" x2="15" y2="12" />
               </svg>
            </button>

            <div class="toolbar-divider"></div>

            <!-- Zone creation -->
            <button class="toolbar-btn" id="addZoneCircleBtn" title="Додати кругову зону">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10" />
               </svg>
            </button>
            <button class="toolbar-btn" id="addZonePolygonBtn" title="Додати полігон">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="12,2 22,22 2,22" />
               </svg>
            </button>
            <button class="toolbar-btn" id="addZoneRectBtn" title="Додати прямокутник">
               <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" />
               </svg>
            </button>
         </div>

         <div class="toolbar-spacer"></div>

         <div class="toolbar-group">
            <select id="mapStyleSelect" class="toolbar-select">
               <option value="streets-v12">Вулиці</option>
               <option value="satellite-streets-v12">Супутник</option>
            </select>
         </div>
      </div>

      <!-- Карта Mapbox -->
      <div id="routesMap" class="routes-map"></div>

      <!-- Статус бар -->
      <div class="map-statusbar" id="mapStatusbar">
         <span id="statusCoords">—</span>
         <span id="statusZoom">Zoom: —</span>
         <span id="statusMode">Режим: Перегляд</span>
      </div>

      <!-- Панель створення/редагування зупинки (замість модалки) -->
      <div id="stopEditPanel" class="stop-edit-panel" style="display: none;">
         <div class="stop-edit-panel-title" id="stopEditPanelTitle">Нова зупинка</div>
         <div class="stop-edit-panel-hint">Перетягуйте помаранчеві маркери на карті, щоб змінити радіус зони. Центральний маркер переміщує зупинку вздовж маршруту.</div>
         <div class="form-group">
            <label for="stopEditName">Назва зупинки</label>
            <input type="text" id="stopEditName" class="input" placeholder="Напр: Центральна площа">
         </div>
         <div class="form-group">
            <label for="stopEditRadius">Радіус (метри)</label>
            <input type="number" id="stopEditRadius" class="input" value="50" min="10" max="5000" step="10">
         </div>
         <div class="stop-edit-panel-actions">
            <button class="btn" id="stopEditSaveBtn">Зберегти</button>
            <button class="btn btn-secondary" id="stopEditCancelBtn">Скасувати</button>
         </div>
      </div>
   </main>

   <!-- Права панель: властивості вибраного елемента -->
   <aside class="routes-properties" id="routesProperties" style="display: none;">
      <div class="properties-header">
         <h3 id="propertiesTitle">Властивості</h3>
         <button class="btn-icon" id="closePropertiesBtn" title="Закрити">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <path d="M18 6L6 18M6 6l12 12" />
            </svg>
         </button>
      </div>

      <div class="properties-content" id="propertiesContent">
      </div>

      <div class="properties-footer" id="propertiesFooter" style="display: none;">
         <button class="btn btn-danger btn-block" id="propertiesDeleteBtn">Видалити маршрут</button>
      </div>
   </aside>
</div>

<!-- Модальне вікно для створення/редагування групи -->
<div class="modal-overlay" id="groupModal" style="display: none;">
   <div class="modal">
      <div class="modal-header">
         <h3 id="groupModalTitle">Нова група</h3>
         <button class="btn-icon" id="closeGroupModal">×</button>
      </div>
      <div class="modal-body">
         <form id="groupForm">
            <input type="hidden" id="groupId" name="id">
            <div class="form-group">
               <label for="groupName">Назва групи</label>
               <input type="text" id="groupName" name="name" class="input" required>
            </div>
            <div class="form-group">
               <label for="groupColor">Колір маршрутів</label>
               <input type="color" id="groupColor" name="color" value="#3388ff">
            </div>
         </form>
      </div>
      <div class="modal-footer">
         <button class="btn btn-danger" id="deleteGroupBtn" style="display: none;">Видалити групу</button>
         <button class="btn" id="saveGroupBtn">Зберегти</button>
         <button class="btn btn-secondary" id="cancelGroupBtn">Скасувати</button>
      </div>
   </div>
</div>
<!-- Модальне вікно для створення зони -->
<div class="modal-overlay" id="zoneModal" style="display: none;">
   <div class="modal">
      <div class="modal-header">
         <h3 id="zoneModalTitle">Нова зона</h3>
         <button class="btn-icon" id="closeZoneModal">×</button>
      </div>
      <div class="modal-body">
         <form id="zoneForm">
            <div class="form-group">
               <label for="zoneName">Назва зони</label>
               <input type="text" id="zoneName" class="input" required placeholder="Напр: Зона реклами центр">
            </div>
            <div class="form-group">
               <label for="zoneType">Тип зони</label>
               <select id="zoneType" class="input">
                  <option value="advertising">Рекламна</option>
                  <option value="info">Інформаційна</option>
                  <option value="service">Сервісна</option>
                  <option value="custom">Кастомна</option>
               </select>
            </div>
         </form>
      </div>
      <div class="modal-footer">
         <button class="btn" id="saveZoneBtn">Зберегти</button>
         <button class="btn btn-secondary" id="cancelZoneBtn">Скасувати</button>
      </div>
   </div>
</div>

<!-- Mapbox GL JS -->
<?php if ($mapboxApiKey): ?>
   <link href="https://api.mapbox.com/mapbox-gl-js/v3.4.0/mapbox-gl.css" rel="stylesheet">
   <script src="https://api.mapbox.com/mapbox-gl-js/v3.4.0/mapbox-gl.js"></script>

   <!-- Mapbox Geocoder (пошук) -->
   <link href="https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-geocoder/v5.0.2/mapbox-gl-geocoder.css" rel="stylesheet">
   <script src="https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-geocoder/v5.0.2/mapbox-gl-geocoder.min.js"></script>

   <!-- Turf.js для snap-to-line та генерації кіл -->
   <script src="https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js"></script>

   <script>
      window.MAPBOX_API_KEY = <?= json_encode($mapboxApiKey) ?>;
      window.ROUTES_READONLY = <?= $routesReadonly ? 'true' : 'false' ?>;
   </script>
   <script src="assets/js/routes.js"></script>
<?php else: ?>
   <script>
      console.error('Mapbox API key not found!');
      document.getElementById('routesMap').innerHTML = '<div class="map-error">Mapbox API ключ не знайдено. Перевірте файл /etc/AdvertismentManager/MapboxAPI.json</div>';
   </script>
<?php endif; ?>