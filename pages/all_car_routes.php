<?php
// Підключається з Manager.php; $db, $db2 та сесія вже доступні
?>

<link rel="stylesheet" href="assets/css/all_car_routes.css">

<div class="acr-wrap" id="acrWrap">
   <div class="acr-header">
      <div>
         <h2 class="acr-title">Усі маршрути і глобальні зони машини</h2>
         <div class="acr-subtitle">Прив'язка довільної кількості маршрутів до IMEI (таблиця all_car_routes)</div>
      </div>
      <div class="acr-header-actions">
         <input type="text" id="acrSearch" class="input acr-search" placeholder="Пошук за IMEI, машиною, аккаунтом або маршрутом...">
         <button id="acrAddBtn" class="btn">+ Додати</button>
      </div>
   </div>

   <div class="acr-table-wrap">
      <table class="acr-table">
         <thead>
            <tr>
               <th class="col-imei">IMEI</th>
               <th class="col-car">Машина</th>
               <th class="col-owner">Аккаунт</th>
               <th class="col-routes">Маршрути</th>
               <th class="col-zones">Глобільні зони</th>
               <th class="col-count">К-сть</th>
               <th class="col-date">Оновлено</th>
               <th class="col-actions"></th>
            </tr>
         </thead>
         <tbody id="acrTableBody">
            <tr>
               <td colspan="8" class="acr-empty">Завантаження...</td>
            </tr>
         </tbody>
      </table>
   </div>
</div>

<!-- Модалка додавання / редагування -->
<div class="acr-modal-overlay" id="acrModal" style="display:none;">
   <div class="acr-modal">
      <div class="acr-modal-header">
         <h3 id="acrModalTitle">Прив'язати маршрути до машини</h3>
         <button class="btn-icon" id="acrModalClose">×</button>
      </div>
      <form id="acrSaveForm" class="acr-modal-body">
         <input type="hidden" id="acrEditId" name="id" value="">

         <div class="form-group">
            <label class="form-label">IMEI машини</label>
            <input type="text" id="acrImeiInput" name="imei" class="input" placeholder="Введіть IMEI..." autocomplete="off">
         </div>

         <div class="form-group">
            <label class="form-label">Маршрути <span class="acr-picked-count" id="acrPickedCount">(обрано: 0)</span></label>
            <input type="text" id="acrRouteSearch" class="input" placeholder="Пошук маршрутів за назвою..." autocomplete="off">
            <div id="acrRouteList" class="acr-route-picker"></div>
            <div class="acr-picked-list" id="acrPickedList"></div>
         </div>

         <div class="form-group">
            <label class="form-label">Глобільні зони <span class="acr-picked-count" id="acrPickedZonesCount">(обрано: 0)</span></label>
            <input type="text" id="acrZoneSearch" class="input" placeholder="Пошук зон за назвою..." autocomplete="off">
            <div id="acrZoneList" class="acr-route-picker"></div>
            <div class="acr-picked-list" id="acrPickedZonesList"></div>
         </div>

         <div class="acr-modal-footer">
            <button type="submit" class="btn" id="acrSaveBtn">Зберегти</button>
            <button type="button" class="btn btn-secondary" id="acrCancelBtn">Скасувати</button>
         </div>
      </form>
   </div>
</div>

<script src="assets/js/all_car_routes.js"></script>