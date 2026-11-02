document.addEventListener('DOMContentLoaded', function () {
   const tbody = document.getElementById('c2rTableBody');
   const searchEl = document.getElementById('c2rSearch');
   const addBtn = document.getElementById('c2rAddBtn');

   const modal = document.getElementById('c2rModal');
   const modalClose = document.getElementById('c2rModalClose');
   const cancelBtn = document.getElementById('c2rCancelBtn');
   const attachForm = document.getElementById('c2rAttachForm');
   const imeiInput = document.getElementById('c2rImeiInput');
   const routeSearchEl1 = document.getElementById('c2rRouteSearch1');
   const pickedRouteIdInput1 = document.getElementById('c2rPickedRouteId1');
   const routeListEl1 = document.getElementById('c2rRouteList1');
   const routeSearchEl2 = document.getElementById('c2rRouteSearch2');
   const pickedRouteIdInput2 = document.getElementById('c2rPickedRouteId2');
   const routeListEl2 = document.getElementById('c2rRouteList2');
   const saveBtn = document.getElementById('c2rSaveBtn');
   const modalTitleEl = modal.querySelector('.c2r-modal-header h3');
   const modalTitleDefault = modalTitleEl ? modalTitleEl.textContent : '';

   let items = [];
   let allRoutes = [];
   let isSaving = false;
   let editingId = null;

   function escapeHtml(s) {
      return String(s == null ? '' : s)
         .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
         .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
   }

   function routeCellHtml(name) {
      if (name) {
         return escapeHtml(name);
      }
      return '<span class="c2r-route-empty">— немає —</span>';
   }

   // =========================================
   // Завантаження списку прив'язок
   // =========================================
   function loadList() {
      tbody.innerHTML = '<tr><td colspan="5" class="c2r-empty">Завантаження...</td></tr>';
      fetch('api/car_to_route.php?action=list')
         .then(r => r.json())
         .then(data => {
            if (data.error) { alert(data.error); return; }
            items = data.items || [];
            render();
         })
         .catch(err => { console.error(err); alert('Помилка завантаження'); });
   }

   function render() {
      const q = (searchEl.value || '').trim().toLowerCase();
      const list = q
         ? items.filter(it => {
            const n1 = (it.first_route_name || '').toLowerCase();
            const n2 = (it.second_route_name || '').toLowerCase();
            return (it.imei || '').toLowerCase().indexOf(q) !== -1
               || n1.indexOf(q) !== -1
               || n2.indexOf(q) !== -1;
         })
         : items;

      tbody.innerHTML = '';
      if (!list.length) {
         tbody.innerHTML = '<tr><td colspan="5" class="c2r-empty">Нічого не знайдено</td></tr>';
         return;
      }

      list.forEach(it => {
         const tr = document.createElement('tr');
         const cnt = it.adverts_count || 0;
         const badgeCls = 'c2r-ads-badge' + (cnt > 0 ? '' : ' empty');

         tr.innerHTML =
            '<td class="col-imei">' + escapeHtml(it.imei || '') + '</td>' +
            '<td class="col-route">' + routeCellHtml(it.first_route_name) + '</td>' +
            '<td class="col-route">' + routeCellHtml(it.second_route_name) + '</td>' +
            '<td class="col-ads"><span class="' + badgeCls + '" title="Сума реклам на обох маршрутах">' + cnt + '</span></td>' +
            '<td class="col-actions">' +
               '<button type="button" class="btn btn-secondary btn-small edit-btn">Редагувати</button> ' +
               '<button type="button" class="btn btn-danger btn-small detach-btn">Видалити</button>' +
            '</td>';

         tr.querySelector('.edit-btn').addEventListener('click', () => openModal(it));
         tr.querySelector('.detach-btn').addEventListener('click', () => doDetach(it));
         tbody.appendChild(tr);
      });
   }

   if (searchEl) {
      searchEl.addEventListener('input', render);
   }

   // =========================================
   // Видалення
   // =========================================
   function doDetach(it) {
      const label = (it.imei || ('#' + it.id))
         + ': ' + (it.first_route_name || '—')
         + ' / ' + (it.second_route_name || '—');
      if (!confirm('Видалити прив\'язку "' + label + '"?')) return;
      const fd = new FormData();
      fd.append('action', 'detach');
      fd.append('id', it.id);
      fetch('api/car_to_route.php', { method: 'POST', body: fd })
         .then(r => r.json())
         .then(j => {
            if (j.ok) loadList();
            else alert('Помилка: ' + (j.errors ? j.errors.join('; ') : (j.error || 'невідома')));
         })
         .catch(err => { console.error(err); alert('Мережева помилка'); });
   }

   // =========================================
   // Модалка: додати прив'язку
   // =========================================
   function renderRoutePicker(listEl, hiddenInput, q) {
      q = (q || '').trim().toLowerCase();
      const routeList = q
         ? allRoutes.filter(r =>
            (r.name || '').toLowerCase().indexOf(q) !== -1 ||
            (r.group_name || '').toLowerCase().indexOf(q) !== -1)
         : allRoutes;

      listEl.innerHTML = '';
      if (!routeList.length) {
         listEl.innerHTML = '<div class="c2r-picker-empty">Маршрутів не знайдено</div>';
         return;
      }

      const pickedId = hiddenInput.value ? parseInt(hiddenInput.value, 10) : 0;
      routeList.forEach(r => {
         const item = document.createElement('div');
         item.className = 'c2r-route-pick' + (r.id === pickedId ? ' selected' : '');
         item.dataset.id = r.id;
         item.innerHTML =
            '<div class="c2r-route-pick-name">' + escapeHtml(r.name || ('#' + r.id)) + '</div>' +
            (r.group_name ? '<div class="c2r-route-pick-group">' + escapeHtml(r.group_name) + '</div>' : '');
         item.addEventListener('click', () => {
            hiddenInput.value = r.id;
            listEl.querySelectorAll('.c2r-route-pick.selected').forEach(n => n.classList.remove('selected'));
            item.classList.add('selected');
         });
         listEl.appendChild(item);
      });
   }

   function openModal(it) {
      const isEdit = !!(it && it.id);
      editingId = isEdit ? it.id : null;

      imeiInput.value = isEdit ? (it.imei || '') : '';
      routeSearchEl1.value = '';
      routeSearchEl2.value = '';
      pickedRouteIdInput1.value = isEdit && it.first_route_id ? String(it.first_route_id) : '';
      pickedRouteIdInput2.value = isEdit && it.second_route_id ? String(it.second_route_id) : '';
      routeListEl1.innerHTML = '<div class="c2r-picker-empty">Завантаження маршрутів...</div>';
      routeListEl2.innerHTML = '<div class="c2r-picker-empty">Завантаження маршрутів...</div>';

      if (modalTitleEl) {
         modalTitleEl.textContent = isEdit
            ? 'Редагувати прив\'язку машини'
            : modalTitleDefault;
      }
      if (saveBtn) saveBtn.textContent = isEdit ? 'Оновити' : 'Зберегти';

      modal.style.display = 'flex';

      fetch('api/car_to_route.php?action=available_routes')
         .then(r => r.json())
         .then(data => {
            allRoutes = data.routes || [];
            renderRoutePicker(routeListEl1, pickedRouteIdInput1, '');
            renderRoutePicker(routeListEl2, pickedRouteIdInput2, '');
         })
         .catch(err => {
            console.error(err);
            routeListEl1.innerHTML = '<div class="c2r-picker-empty">Помилка завантаження</div>';
            routeListEl2.innerHTML = '<div class="c2r-picker-empty">Помилка завантаження</div>';
         });

      setTimeout(() => imeiInput.focus(), 50);
   }

   routeSearchEl1.addEventListener('input', () => renderRoutePicker(routeListEl1, pickedRouteIdInput1, routeSearchEl1.value));
   routeSearchEl2.addEventListener('input', () => renderRoutePicker(routeListEl2, pickedRouteIdInput2, routeSearchEl2.value));

   function closeModal() {
      modal.style.display = 'none';
      editingId = null;
      if (modalTitleEl) modalTitleEl.textContent = modalTitleDefault;
   }

   addBtn.addEventListener('click', () => openModal(null));
   modalClose.addEventListener('click', closeModal);
   cancelBtn.addEventListener('click', closeModal);
   modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

   attachForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (isSaving) return;

      const imei = (imeiInput.value || '').trim();
      const routeId1 = pickedRouteIdInput1.value;
      const routeId2 = pickedRouteIdInput2.value;
      if (!imei) { alert('Вкажіть IMEI машини'); return; }
      if (!routeId1) { alert('Виберіть маршрут A → B'); return; }
      if (!routeId2) { alert('Виберіть маршрут B → A'); return; }
      if (String(routeId1) === String(routeId2)) {
         alert('Потрібні два різні маршрути для прямого та зворотного напрямку');
         return;
      }

      const existing = items.find(it => String(it.imei) === imei && it.id !== editingId);
      if (existing) {
         const same = String(existing.first_route_id) === String(routeId1)
            && String(existing.second_route_id) === String(routeId2);
         if (same) {
            alert('Для цього IMEI вже збережені саме ці два маршрути');
            return;
         }
         const r1 = allRoutes.find(r => String(r.id) === String(routeId1));
         const r2 = allRoutes.find(r => String(r.id) === String(routeId2));
         const msg = 'IMEI ' + imei + ' вже має маршрути:\n'
            + '  • ' + (existing.first_route_name || '#' + existing.first_route_id) + '\n'
            + '  • ' + (existing.second_route_name || '#' + existing.second_route_id)
            + '\n\nЗамінити на:\n'
            + '  • ' + (r1 ? r1.name : '#' + routeId1) + '\n'
            + '  • ' + (r2 ? r2.name : '#' + routeId2) + '?';
         if (!confirm(msg)) return;
      }

      const fd = new FormData();
      fd.append('action', 'attach');
      fd.append('imei', imei);
      fd.append('first_route_id', routeId1);
      fd.append('second_route_id', routeId2);

      isSaving = true;
      const orig = saveBtn.textContent;
      saveBtn.textContent = 'Збереження...';
      saveBtn.disabled = true;

      fetch('api/car_to_route.php', { method: 'POST', body: fd })
         .then(r => r.json())
         .then(j => {
            if (j.ok) { closeModal(); loadList(); }
            else alert('Помилка: ' + (j.errors ? j.errors.join('; ') : (j.error || 'невідома')));
         })
         .catch(err => { console.error(err); alert('Мережева помилка'); })
         .finally(() => {
            isSaving = false;
            saveBtn.disabled = false;
            saveBtn.textContent = orig;
         });
   });

   loadList();
});
