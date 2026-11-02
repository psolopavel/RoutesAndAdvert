<?php
// Підключається з Manager.php; $db, $db2 та сесія вже доступні
?>

<link rel="stylesheet" href="assets/css/advert_to_route.css">

<div class="a2r-wrap" id="a2rWrap">
   <!-- Ліва панель: групи + маршрути -->
   <aside class="a2r-sidebar" id="a2rSidebar">
      <div class="a2r-sidebar-header">
         <strong class="a2r-title">Маршрути</strong>
      </div>
      <div class="a2r-search-box">
         <input type="text" id="a2rRouteSearch" class="input" placeholder="Пошук маршрутів...">
      </div>
      <div class="a2r-tabs" id="a2rTabs"></div>
      <div class="a2r-routes-list" id="a2rRoutesList">
         <div class="a2r-empty">Завантаження...</div>
      </div>
   </aside>

   <!-- Права панель -->
   <main class="a2r-main">
      <div class="a2r-main-header">
         <div>
            <h2 id="a2rRouteTitle" class="a2r-route-title">Виберіть маршрут</h2>
            <div id="a2rRouteSubtitle" class="a2r-route-subtitle"></div>
         </div>
      </div>

      <div id="a2rEmpty" class="a2r-empty-large">Виберіть маршрут зі списку зліва</div>

      <div id="a2rContent" style="display:none;">
         <!-- ============ Блок: за часом ============ -->
         <section class="a2r-block" id="a2rTimeBlock">
            <div class="a2r-block-header" data-collapse="a2rTimeBody">
               <span class="a2r-collapse-icon">▾</span>
               <span class="a2r-block-title">За часом (розклад)</span>
               <span class="a2r-block-sub" id="a2rTimeBlockSub"></span>
            </div>
            <div class="a2r-block-body" id="a2rTimeBody">
               <!-- Налаштування -->
               <div class="a2r-time-config">
                  <div class="a2r-cfg-field">
                     <label class="form-label">Початок (UTC+3)</label>
                     <input type="time" id="a2rStart" class="input" step="60" value="06:00">
                  </div>
                  <div class="a2r-cfg-field">
                     <label class="form-label">Кінець (UTC+3)</label>
                     <input type="time" id="a2rEnd" class="input" step="60" value="23:00">
                  </div>
                  <div class="a2r-cfg-field">
                     <label class="form-label">Інтервал</label>
                     <select id="a2rInterval" class="input">
                        <option value="2">кожні 2 хв</option>
                        <option value="3">кожні 3 хв</option>
                        <option value="4">кожні 4 хв</option>
                        <option value="5" selected>кожні 5 хв</option>
                        <option value="7">кожні 7 хв</option>
                        <option value="10">кожні 10 хв</option>
                     </select>
                  </div>
                  <div class="a2r-cfg-field a2r-cfg-slots">
                     <span class="a2r-slots-badge" id="a2rSlotsCount">0 слотів</span>
                  </div>
               </div>

               <!-- Цикл ротації -->
               <div class="a2r-rotation-section">
                  <div class="a2r-subhead">
                     <span>Цикл ротації</span>
                     <button type="button" class="btn" id="a2rAddRotationBtn">+ Додати рекламу</button>
                  </div>
                  <div class="a2r-hint">Реклами програються по колу в цьому порядку. Одну рекламу можна додати кілька разів — це збільшить її частоту.</div>
                  <div id="a2rRotationList" class="a2r-rotation-list">
                     <div class="a2r-empty">Цикл порожній</div>
                  </div>
               </div>

               <!-- Сітка-превʼю -->
               <div class="a2r-grid-section">
                  <div class="a2r-subhead">
                     <span>Сітка розкладу (UTC+3)</span>
                     <span class="a2r-hint" style="margin:0;">Клік по комірці — замінити рекламу для цього часу</span>
                  </div>
                  <div id="a2rGridPreview" class="a2r-grid-preview">
                     <div class="a2r-empty">Додайте рекламу в цикл</div>
                  </div>
               </div>

               <div class="a2r-time-actions">
                  <button type="button" class="btn" id="a2rSaveScheduleBtn">Зберегти розклад</button>
               </div>
            </div>
         </section>

         <!-- ============ Блок: за зоною ============ -->
         <section class="a2r-block" id="a2rZoneBlock">
            <div class="a2r-block-header" data-collapse="a2rZoneBody">
               <span class="a2r-collapse-icon">▾</span>
               <span class="a2r-block-title">За зоною</span>
               <span class="a2r-block-sub" id="a2rZoneBlockSub"></span>
               <button type="button" class="btn a2r-block-add" id="a2rAddZoneBtn">+ Додати</button>
            </div>
            <div class="a2r-block-body" id="a2rZoneBody">
               <div id="a2rZoneList" class="a2r-adverts-list">
                  <div class="a2r-empty-large">Немає прив'язок за зоною</div>
               </div>
            </div>
         </section>
      </div>
   </main>
</div>

<!-- Модалка вибору реклами (для циклу ротації та заміни комірки) -->
<div class="a2r-modal-overlay" id="a2rPickModal" style="display:none;">
   <div class="a2r-modal">
      <div class="a2r-modal-header">
         <h3 id="a2rPickTitle">Вибрати рекламу</h3>
         <button class="btn-icon" id="a2rPickClose">×</button>
      </div>
      <div class="a2r-modal-body">
         <div class="form-group">
            <label class="form-label">Реклама</label>
            <div class="a2r-ads-picker" id="a2rPickPicker">
               <div class="a2r-empty">Завантаження...</div>
            </div>
            <input type="hidden" id="a2rPickAdId">
         </div>
         <div class="form-group">
            <label class="form-label">Показів за подію</label>
            <input type="number" id="a2rPickDpe" class="input" value="1" min="1" step="1">
         </div>
         <div class="a2r-modal-footer">
            <button type="button" class="btn" id="a2rPickSave">Додати</button>
            <button type="button" class="btn btn-secondary" id="a2rPickCancel">Скасувати</button>
         </div>
      </div>
   </div>
</div>

<!-- Модалка прив'язки за зоною -->
<div class="a2r-modal-overlay" id="a2rZoneModal" style="display:none;">
   <div class="a2r-modal">
      <div class="a2r-modal-header">
         <h3 id="a2rZoneTitle">Додати рекламу до зони</h3>
         <button class="btn-icon" id="a2rZoneClose">×</button>
      </div>
      <div class="a2r-modal-body">
         <input type="hidden" id="a2rZoneEditId">
         <div class="form-group">
            <label class="form-label">Реклама</label>
            <div class="a2r-ads-picker" id="a2rZonePicker">
               <div class="a2r-empty">Завантаження...</div>
            </div>
            <input type="hidden" id="a2rZoneAdId">
         </div>
         <div class="form-group">
            <label class="form-label">Рекламна зона маршруту</label>
            <select id="a2rZoneSelect" class="input">
               <option value="">— виберіть зону —</option>
            </select>
            <div class="a2r-hint">Список зон типу advertising, прив'язаних до цього маршруту.</div>
         </div>
         <div class="form-group">
            <label class="form-label">Показів за подію</label>
            <input type="number" id="a2rZoneDpe" class="input" value="1" min="1" step="1">
         </div>
         <div class="a2r-modal-footer">
            <button type="button" class="btn" id="a2rZoneSave">Зберегти</button>
            <button type="button" class="btn btn-secondary" id="a2rZoneCancel">Скасувати</button>
         </div>
      </div>
   </div>
</div>

<script src="assets/js/advert_to_route.js"></script>