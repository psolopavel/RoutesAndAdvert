<?php
// Підключається з Manager.php (лише для admin); $db2 та $currentUser вже доступні
?>

<link rel="stylesheet" href="assets/css/car_to_route.css">
<link rel="stylesheet" href="assets/css/users.css">

<div class="usr-wrap">
   <!-- Ліва панель: список користувачів -->
   <aside class="usr-sidebar">
      <div class="usr-sidebar-header">
         <strong class="usr-title">Користувачі</strong>
         <button type="button" class="btn btn-small" id="usrNewBtn">+ Новий</button>
      </div>
      <div class="usr-search-box">
         <input type="text" id="usrSearch" class="input" placeholder="Пошук за логіном або ім'ям...">
      </div>
      <div class="usr-list" id="usrList">
         <div class="usr-empty">Завантаження...</div>
      </div>
   </aside>

   <!-- Права панель: картка користувача -->
   <main class="usr-main">
      <div id="usrEmpty" class="usr-empty usr-empty-large">Виберіть користувача зі списку або створіть нового</div>

      <div id="usrContent" style="display:none;">
         <section class="usr-block">
            <div class="usr-block-title" id="usrFormTitle">Новий користувач</div>
            <form id="usrForm" autocomplete="off">
               <input type="hidden" id="usrId">
               <div class="usr-form-grid">
                  <div class="form-group">
                     <label class="form-label" for="usrLogin">Логін</label>
                     <input type="text" id="usrLogin" class="input" maxlength="64" placeholder="латиниця, цифри, . _ @ -" autocomplete="off">
                  </div>
                  <div class="form-group">
                     <label class="form-label" for="usrDisplayName">Ім'я / компанія</label>
                     <input type="text" id="usrDisplayName" class="input" maxlength="128" placeholder="необов'язково">
                  </div>
                  <div class="form-group">
                     <label class="form-label" for="usrRole">Роль</label>
                     <select id="usrRole" class="input">
                        <?php foreach (AUTH_ROLE_LABELS as $roleKey => $roleLabel): ?>
                           <option value="<?= htmlspecialchars($roleKey, ENT_QUOTES, 'UTF-8') ?>" <?= $roleKey === 'client' ? 'selected' : '' ?>>
                              <?= htmlspecialchars($roleLabel, ENT_QUOTES, 'UTF-8') ?>
                           </option>
                        <?php endforeach; ?>
                     </select>
                  </div>
                  <div class="form-group">
                     <label class="form-label" for="usrPassword" id="usrPasswordLabel">Пароль</label>
                     <input type="password" id="usrPassword" class="input" placeholder="мін. 6 символів" autocomplete="new-password">
                  </div>
               </div>
               <label class="usr-checkbox">
                  <input type="checkbox" id="usrActive" checked>
                  <span>Активний (може входити)</span>
               </label>
               <div class="usr-form-actions">
                  <button type="submit" class="btn" id="usrSaveBtn">Створити</button>
                  <button type="button" class="btn btn-danger" id="usrDeleteBtn" style="display:none;">Видалити користувача</button>
               </div>
            </form>
         </section>

         <div id="usrAssignments" style="display:none;">
            <div class="usr-hint" id="usrRoleHint">IMEI та маршрути обмежують доступ лише для ролі «Клієнт». Інші ролі бачать усе.</div>

            <section class="usr-block">
               <div class="usr-block-title">IMEI машин <span class="usr-count" id="usrImeiCount"></span></div>
               <div class="usr-imei-add">
                  <textarea id="usrImeiInput" class="input" rows="2" placeholder="Один IMEI або кілька через кому, пробіл чи з нового рядка"></textarea>
                  <button type="button" class="btn" id="usrImeiAddBtn">Додати</button>
               </div>
               <div class="usr-result" id="usrImeiResult"></div>
               <div class="usr-chips" id="usrImeiList"></div>
            </section>

            <section class="usr-block">
               <div class="usr-block-title">Маршрути <span class="usr-count" id="usrRouteCount"></span></div>
               <div class="usr-hint">Разом із маршрутом автоматично призначається пов'язаний з ним зворотний маршрут.</div>
               <input type="text" id="usrRouteSearch" class="input usr-route-search" placeholder="Пошук маршруту для призначення...">
               <div class="c2r-route-picker usr-route-picker" id="usrRoutePicker"></div>
               <div class="usr-assigned-routes" id="usrRouteList"></div>
            </section>
         </div>
      </div>
   </main>
</div>

<script src="assets/js/users.js"></script>
