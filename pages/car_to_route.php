<?php
// Підключається з Manager.php; $db, $db2 та $currentUser вже доступні

// Клієнт обирає IMEI лише зі списку призначених йому
$c2rIsClient = authIsClient($currentUser);
$c2rImeis = $c2rIsClient ? authUserImeis($currentUser) : [];
?>

<link rel="stylesheet" href="assets/css/car_to_route.css">

<div class="c2r-wrap" id="c2rWrap">
   <div class="c2r-header">
      <div>
         <h2 class="c2r-title">Транспорт до маршруту</h2>
         <div class="c2r-subtitle">Два маршрути на машину (A→B та B→A) та сумарна кількість реклами по них</div>
      </div>
      <div class="c2r-header-actions">
         <input type="text" id="c2rSearch" class="input c2r-search" placeholder="Пошук за IMEI або назвою маршруту...">
         <button id="c2rAddBtn" class="btn" <?= $c2rIsClient && !$c2rImeis ? 'disabled title="Вам ще не призначено жодного IMEI"' : '' ?>>+ Додати</button>
      </div>
   </div>
   <?php if ($c2rIsClient && !$c2rImeis): ?>
      <div class="c2r-subtitle" style="margin-bottom:12px;">Вам ще не призначено жодного IMEI. Зверніться до адміністратора.</div>
   <?php endif; ?>

   <div class="c2r-table-wrap">
      <table class="c2r-table">
         <thead>
            <tr>
               <th class="col-imei">IMEI</th>
               <th class="col-route">Маршрут A → B</th>
               <th class="col-route">Маршрут B → A</th>
               <th class="col-ads">Реклам</th>
               <th class="col-actions"></th>
            </tr>
         </thead>
         <tbody id="c2rTableBody">
            <tr>
               <td colspan="5" class="c2r-empty">Завантаження...</td>
            </tr>
         </tbody>
      </table>
   </div>
</div>

<!-- Модалка додавання -->
<div class="c2r-modal-overlay" id="c2rModal" style="display:none;">
   <div class="c2r-modal">
      <div class="c2r-modal-header">
         <h3>Прив'язати машину до двох маршрутів</h3>
         <button class="btn-icon" id="c2rModalClose">×</button>
      </div>
      <form id="c2rAttachForm" class="c2r-modal-body">
         <div class="form-group">
            <label class="form-label">IMEI машини</label>
            <?php if ($c2rIsClient): ?>
               <select id="c2rImeiInput" name="imei" class="input">
                  <option value="">— виберіть IMEI —</option>
                  <?php foreach ($c2rImeis as $imei): ?>
                     <option value="<?= htmlspecialchars($imei, ENT_QUOTES, 'UTF-8') ?>"><?= htmlspecialchars($imei, ENT_QUOTES, 'UTF-8') ?></option>
                  <?php endforeach; ?>
               </select>
            <?php else: ?>
               <input type="text" id="c2rImeiInput" name="imei" class="input" placeholder="Введіть IMEI..." autocomplete="off">
            <?php endif; ?>
         </div>

         <div class="form-group">
            <label class="form-label">Маршрут A → B</label>
            <input type="text" id="c2rRouteSearch1" class="input" placeholder="Пошук маршрутів за назвою..." autocomplete="off">
            <input type="hidden" id="c2rPickedRouteId1" name="first_route_id">
            <div id="c2rRouteList1" class="c2r-route-picker"></div>
         </div>

         <div class="form-group">
            <label class="form-label">Маршрут B → A</label>
            <input type="text" id="c2rRouteSearch2" class="input" placeholder="Пошук маршрутів за назвою..." autocomplete="off">
            <input type="hidden" id="c2rPickedRouteId2" name="second_route_id">
            <div id="c2rRouteList2" class="c2r-route-picker"></div>
         </div>

         <div class="c2r-modal-footer">
            <button type="submit" class="btn" id="c2rSaveBtn">Зберегти</button>
            <button type="button" class="btn btn-secondary" id="c2rCancelBtn">Скасувати</button>
         </div>
      </form>
   </div>
</div>

<script src="assets/js/car_to_route.js"></script>
