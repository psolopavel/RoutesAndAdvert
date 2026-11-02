document.addEventListener('DOMContentLoaded', function () {
   const API_URL = 'api/users.php';

   const listEl = document.getElementById('usrList');
   const searchEl = document.getElementById('usrSearch');
   const newBtn = document.getElementById('usrNewBtn');
   const emptyEl = document.getElementById('usrEmpty');
   const contentEl = document.getElementById('usrContent');

   const form = document.getElementById('usrForm');
   const formTitle = document.getElementById('usrFormTitle');
   const idInput = document.getElementById('usrId');
   const loginInput = document.getElementById('usrLogin');
   const nameInput = document.getElementById('usrDisplayName');
   const roleSelect = document.getElementById('usrRole');
   const passwordInput = document.getElementById('usrPassword');
   const passwordLabel = document.getElementById('usrPasswordLabel');
   const activeInput = document.getElementById('usrActive');
   const saveBtn = document.getElementById('usrSaveBtn');
   const deleteBtn = document.getElementById('usrDeleteBtn');

   const assignmentsEl = document.getElementById('usrAssignments');
   const roleHint = document.getElementById('usrRoleHint');
   const imeiInput = document.getElementById('usrImeiInput');
   const imeiAddBtn = document.getElementById('usrImeiAddBtn');
   const imeiResult = document.getElementById('usrImeiResult');
   const imeiListEl = document.getElementById('usrImeiList');
   const imeiCount = document.getElementById('usrImeiCount');
   const routeSearch = document.getElementById('usrRouteSearch');
   const routePicker = document.getElementById('usrRoutePicker');
   const routeListEl = document.getElementById('usrRouteList');
   const routeCount = document.getElementById('usrRouteCount');

   const ROUTE_PICKER_LIMIT = 50;

   let users = [];
   let roles = {};
   let currentUserId = null;
   let selectedId = null;
   let routesCatalog = null;

   function escapeHtml(s) {
      return String(s == null ? '' : s)
         .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
         .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
   }

   function post(action, fields) {
      const fd = new FormData();
      fd.append('action', action);
      Object.keys(fields || {}).forEach(k => fd.append(k, fields[k]));
      return fetch(API_URL, { method: 'POST', body: fd }).then(r => r.json());
   }

   function errorText(j) {
      return j.error || (j.errors ? j.errors.join('; ') : 'невідома помилка');
   }

   // =========================================
   // Список користувачів
   // =========================================
   function loadUsers() {
      return fetch(API_URL + '?action=list')
         .then(r => r.json())
         .then(data => {
            if (data.error) { alert(data.error); return; }
            users = data.users || [];
            roles = data.roles || {};
            currentUserId = data.current_user_id || null;
            renderList();
         })
         .catch(err => { console.error(err); alert('Помилка завантаження користувачів'); });
   }

   function renderList() {
      const q = (searchEl.value || '').trim().toLowerCase();
      const list = q
         ? users.filter(u => (u.login || '').toLowerCase().indexOf(q) !== -1
            || (u.display_name || '').toLowerCase().indexOf(q) !== -1)
         : users;

      listEl.innerHTML = '';
      if (!list.length) {
         listEl.innerHTML = '<div class="usr-empty">' + (users.length ? 'Нічого не знайдено' : 'Користувачів ще немає') + '</div>';
         return;
      }

      list.forEach(u => {
         const item = document.createElement('div');
         item.className = 'usr-item' + (u.id === selectedId ? ' active' : '') + (u.active ? '' : ' inactive');
         const meta = [roles[u.role] || u.role];
         if (u.role === 'client') meta.push('IMEI: ' + u.imeis_count, 'маршрутів: ' + u.routes_count);
         if (!u.active) meta.push('заблоковано');
         item.innerHTML =
            '<div class="usr-item-login">' + escapeHtml(u.login) + (u.display_name ? ' — ' + escapeHtml(u.display_name) : '') + '</div>' +
            '<div class="usr-item-meta">' + escapeHtml(meta.join(' • ')) + '</div>';
         item.addEventListener('click', () => selectUser(u.id));
         listEl.appendChild(item);
      });
   }

   searchEl.addEventListener('input', renderList);

   // =========================================
   // Картка користувача
   // =========================================
   function showForm(user) {
      const isEdit = !!user;
      emptyEl.style.display = 'none';
      contentEl.style.display = '';

      idInput.value = isEdit ? user.id : '';
      loginInput.value = isEdit ? user.login : '';
      nameInput.value = isEdit ? (user.display_name || '') : '';
      roleSelect.value = isEdit ? user.role : 'client';
      activeInput.checked = isEdit ? !!user.active : true;
      passwordInput.value = '';

      formTitle.textContent = isEdit ? ('Користувач ' + user.login) : 'Новий користувач';
      passwordLabel.textContent = isEdit ? 'Новий пароль (залиште порожнім, щоб не змінювати)' : 'Пароль';
      saveBtn.textContent = isEdit ? 'Зберегти' : 'Створити';

      const isSelf = isEdit && user.id === currentUserId;
      deleteBtn.style.display = isEdit && !isSelf ? '' : 'none';
      roleSelect.disabled = isSelf;
      activeInput.disabled = isSelf;

      assignmentsEl.style.display = isEdit ? '' : 'none';
      updateRoleHint();
   }

   function updateRoleHint() {
      roleHint.style.display = roleSelect.value === 'client' ? 'none' : '';
   }

   roleSelect.addEventListener('change', updateRoleHint);

   function selectUser(id) {
      selectedId = id;
      renderList();
      imeiResult.innerHTML = '';
      imeiInput.value = '';
      routeSearch.value = '';
      routePicker.innerHTML = '';
      return reloadSelected(true);
   }

   function reloadSelected(resetForm) {
      if (!selectedId) return Promise.resolve();
      return fetch(API_URL + '?action=get&id=' + selectedId)
         .then(r => r.json())
         .then(data => {
            if (data.error) { alert(data.error); return; }
            if (resetForm) showForm(data.user);
            renderImeis(data.imeis || []);
            renderRoutes(data.routes || []);
         })
         .catch(err => { console.error(err); alert('Помилка завантаження користувача'); });
   }

   newBtn.addEventListener('click', () => {
      selectedId = null;
      renderList();
      showForm(null);
      loginInput.focus();
   });

   form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fields = {
         id: idInput.value || '0',
         login: loginInput.value.trim(),
         display_name: nameInput.value.trim(),
         role: roleSelect.value,
         active: activeInput.checked ? '1' : '',
         password: passwordInput.value,
      };
      if (!fields.login) { alert('Вкажіть логін'); return; }
      if (!idInput.value && !fields.password) { alert('Вкажіть пароль'); return; }

      saveBtn.disabled = true;
      post('save', fields)
         .then(j => {
            if (!j.ok) { alert('Помилка: ' + errorText(j)); return; }
            return loadUsers().then(() => selectUser(j.id));
         })
         .catch(err => { console.error(err); alert('Мережева помилка'); })
         .finally(() => { saveBtn.disabled = false; });
   });

   deleteBtn.addEventListener('click', () => {
      const id = parseInt(idInput.value, 10);
      if (!id) return;
      if (!confirm('Видалити користувача "' + loginInput.value + '"?\nЙого IMEI та маршрути буде звільнено, а реклама залишиться без власника.')) return;
      post('delete', { id: id })
         .then(j => {
            if (!j.ok) { alert('Помилка: ' + errorText(j)); return; }
            selectedId = null;
            contentEl.style.display = 'none';
            emptyEl.style.display = '';
            routesCatalog = null;
            loadUsers();
         })
         .catch(err => { console.error(err); alert('Мережева помилка'); });
   });

   // =========================================
   // IMEI
   // =========================================
   function renderImeis(imeis) {
      imeiCount.textContent = '(' + imeis.length + ')';
      imeiListEl.innerHTML = '';
      if (!imeis.length) {
         imeiListEl.innerHTML = '<div class="usr-empty">IMEI не призначено</div>';
         return;
      }
      imeis.forEach(imei => {
         const chip = document.createElement('span');
         chip.className = 'usr-chip';
         chip.innerHTML = escapeHtml(imei) + '<button type="button" class="btn-icon" title="Прибрати">×</button>';
         chip.querySelector('button').addEventListener('click', () => {
            if (!confirm('Прибрати IMEI ' + imei + ' у користувача?')) return;
            post('remove_imei', { user_id: selectedId, imei: imei })
               .then(j => {
                  if (!j.ok) { alert('Помилка: ' + errorText(j)); return; }
                  reloadSelected(false);
                  loadUsers();
               })
               .catch(err => { console.error(err); alert('Мережева помилка'); });
         });
         imeiListEl.appendChild(chip);
      });
   }

   function renderImeiResult(j) {
      const parts = [];
      if (j.added.length) parts.push('<div class="ok">Додано: ' + escapeHtml(j.added.join(', ')) + '</div>');
      if (j.already.length) parts.push('<div class="warn">Вже були в цього користувача: ' + escapeHtml(j.already.join(', ')) + '</div>');
      if (j.taken.length) {
         parts.push('<div class="err">Належать іншим користувачам: ' + escapeHtml(j.taken.map(t => t.imei + (t.login ? ' (' + t.login + ')' : '')).join(', ')) + '</div>');
      }
      if (j.invalid.length) parts.push('<div class="err">Некоректні значення: ' + escapeHtml(j.invalid.join(', ')) + '</div>');
      imeiResult.innerHTML = parts.join('');
   }

   imeiAddBtn.addEventListener('click', () => {
      const raw = imeiInput.value.trim();
      if (!raw || !selectedId) return;
      imeiAddBtn.disabled = true;
      post('add_imeis', { user_id: selectedId, imeis: raw })
         .then(j => {
            if (!j.ok) { alert('Помилка: ' + errorText(j)); return; }
            renderImeiResult(j);
            if (!j.taken.length && !j.invalid.length) imeiInput.value = '';
            reloadSelected(false);
            loadUsers();
         })
         .catch(err => { console.error(err); alert('Мережева помилка'); })
         .finally(() => { imeiAddBtn.disabled = false; });
   });

   // =========================================
   // Маршрути
   // =========================================
   function renderRoutes(routes) {
      routeCount.textContent = '(' + routes.length + ')';
      routeListEl.innerHTML = '';
      if (!routes.length) {
         routeListEl.innerHTML = '<div class="usr-empty">Маршрути не призначено</div>';
         return;
      }
      routes.forEach(r => {
         const row = document.createElement('div');
         row.className = 'usr-route-row';
         row.innerHTML =
            '<div>' +
            '<div class="usr-route-row-name">' + escapeHtml(r.name || ('#' + r.id)) + '</div>' +
            (r.group_name ? '<div class="usr-route-row-group">' + escapeHtml(r.group_name) + '</div>' : '') +
            '</div>' +
            '<button type="button" class="btn-icon" title="Зняти маршрут">×</button>';
         row.querySelector('button').addEventListener('click', () => {
            if (!confirm('Зняти маршрут "' + (r.name || r.id) + '" (разом із пов\'язаним зворотним)?')) return;
            post('remove_route', { user_id: selectedId, route_id: r.id })
               .then(j => {
                  if (!j.ok) { alert('Помилка: ' + errorText(j)); return; }
                  routesCatalog = null;
                  reloadSelected(false);
                  loadUsers();
                  renderRoutePicker();
               })
               .catch(err => { console.error(err); alert('Мережева помилка'); });
         });
         routeListEl.appendChild(row);
      });
   }

   function fetchCatalog() {
      if (routesCatalog) return Promise.resolve(routesCatalog);
      return fetch(API_URL + '?action=routes_catalog')
         .then(r => r.json())
         .then(d => { routesCatalog = d.routes || []; return routesCatalog; });
   }

   function renderRoutePicker() {
      const q = (routeSearch.value || '').trim().toLowerCase();
      if (!q) { routePicker.innerHTML = ''; return; }

      fetchCatalog().then(catalog => {
         const found = catalog.filter(r =>
            (r.name || '').toLowerCase().indexOf(q) !== -1 ||
            (r.group_name || '').toLowerCase().indexOf(q) !== -1);

         routePicker.innerHTML = '';
         if (!found.length) {
            routePicker.innerHTML = '<div class="c2r-picker-empty">Маршрутів не знайдено</div>';
            return;
         }

         found.slice(0, ROUTE_PICKER_LIMIT).forEach(r => {
            const ownedBySelf = r.owner_id === selectedId;
            const ownedByOther = r.owner_id !== null && !ownedBySelf;
            const item = document.createElement('div');
            item.className = 'c2r-route-pick' + (r.owner_id !== null ? ' disabled' : '');
            let ownerHtml = '';
            if (ownedBySelf) ownerHtml = '<div class="usr-route-pick-owner">вже призначено цьому користувачу</div>';
            else if (ownedByOther) ownerHtml = '<div class="usr-route-pick-owner">належить: ' + escapeHtml(r.owner_login || ('#' + r.owner_id)) + '</div>';
            item.innerHTML =
               '<div class="c2r-route-pick-name">' + escapeHtml(r.name || ('#' + r.id)) + '</div>' +
               (r.group_name ? '<div class="c2r-route-pick-group">' + escapeHtml(r.group_name) + '</div>' : '') +
               ownerHtml;
            if (r.owner_id === null) {
               item.addEventListener('click', () => assignRoute(r));
            }
            routePicker.appendChild(item);
         });
         if (found.length > ROUTE_PICKER_LIMIT) {
            const more = document.createElement('div');
            more.className = 'c2r-picker-empty';
            more.textContent = 'Показано ' + ROUTE_PICKER_LIMIT + ' з ' + found.length + ' — уточніть пошук';
            routePicker.appendChild(more);
         }
      }).catch(err => {
         console.error(err);
         routePicker.innerHTML = '<div class="c2r-picker-empty">Помилка завантаження маршрутів</div>';
      });
   }

   function assignRoute(route) {
      post('add_route', { user_id: selectedId, route_id: route.id })
         .then(j => {
            if (!j.ok) { alert('Помилка: ' + errorText(j)); return; }
            routesCatalog = null;
            reloadSelected(false);
            loadUsers();
            renderRoutePicker();
         })
         .catch(err => { console.error(err); alert('Мережева помилка'); });
   }

   let routeSearchTimer = null;
   routeSearch.addEventListener('input', () => {
      clearTimeout(routeSearchTimer);
      routeSearchTimer = setTimeout(renderRoutePicker, 200);
   });

   loadUsers();
});
