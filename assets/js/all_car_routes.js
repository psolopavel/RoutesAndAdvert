document.addEventListener('DOMContentLoaded', function () {
   const tbody = document.getElementById('acrTableBody');
   const searchEl = document.getElementById('acrSearch');
   const addBtn = document.getElementById('acrAddBtn');

   const modal = document.getElementById('acrModal');
   const modalClose = document.getElementById('acrModalClose');
   const cancelBtn = document.getElementById('acrCancelBtn');
   const saveForm = document.getElementById('acrSaveForm');
   const saveBtn = document.getElementById('acrSaveBtn');
   const editIdInput = document.getElementById('acrEditId');
   const imeiInput = document.getElementById('acrImeiInput');
   const routeSearchEl = document.getElementById('acrRouteSearch');
   const routeListEl = document.getElementById('acrRouteList');
   const pickedListEl = document.getElementById('acrPickedList');
   const pickedCountEl = document.getElementById('acrPickedCount');
   const zoneSearchEl = document.getElementById('acrZoneSearch');
   const zoneListEl = document.getElementById('acrZoneList');
   const pickedZonesListEl = document.getElementById('acrPickedZonesList');
   const pickedZonesCountEl = document.getElementById('acrPickedZonesCount');
   const modalTitleEl = document.getElementById('acrModalTitle');
   const modalTitleDefault = modalTitleEl ? modalTitleEl.textContent : '';

   let items = [];
   let allRoutes = [];
   let allZones = [];
   /** @type {Set<number>} */
   let pickedIds = new Set();
   /** @type {Set<number>} */
   let pickedZoneIds = new Set();
   let isSaving = false;

   function escapeHtml(s) {
      return String(s == null ? '' : s)
         .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
         .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
   }

   const ACR_CHIP_MAX = 3;

   const ACR_ZONE_TYPE_LABELS = {
      final_stop: 'Кінцева зупинка',
      counting_ignoring: 'Ігнорування підрахунку',
   };

   function zoneTypeLabel(type) {
      return ACR_ZONE_TYPE_LABELS[type] || ACR_ZONE_TYPE_LABELS.final_stop;
   }

   function zoneChipClass(type) {
      return type === 'counting_ignoring' ? 'acr-zone-chip acr-zone-chip--ignore' : 'acr-zone-chip';
   }

   /**
    * @param {Array<{label:string, chipClass:string, missing?:boolean}>} chipItems
    * @param {{ emptyClass: string, emptyLabel: string, missingClass: string }} opts
    */
   function buildChipsCellHtml(chipItems, opts) {
      if (!chipItems.length) {
         return '<div class="acr-routes-cell">' +
            '<span class="' + opts.emptyClass + '">' + escapeHtml(opts.emptyLabel) + '</span></div>';
      }

      const visible = chipItems.slice(0, ACR_CHIP_MAX);
      const overflow = chipItems.slice(ACR_CHIP_MAX);
      const chipHtml = (items) => items.map(it => {
         const cls = it.missing ? opts.missingClass : it.chipClass;
         return '<span class="' + cls + '">' + escapeHtml(it.label) + '</span>';
      }).join('');

      if (chipItems.length <= ACR_CHIP_MAX) {
         return '<div class="acr-routes-cell">' + chipHtml(visible) + '</div>';
      }

      const wrapCls = 'acr-chips-wrap has-overflow';
      return '<div class="' + wrapCls + '">' +
         '<div class="acr-routes-cell acr-chips-compact">' +
         chipHtml(visible) +
         '<span class="acr-chips-ellipsis" title="Наведіть, щоб побачити решту">…</span>' +
         '</div>' +
         '<div class="acr-chips-popover" role="tooltip">' +
         '<div class="acr-routes-cell">' + chipHtml(overflow) + '</div>' +
         '</div></div>';
   }

   // =========================================
   // Завантаження списку
   // =========================================
   function loadList() {
      tbody.innerHTML = '<tr><td colspan="7" class="acr-empty">Завантаження...</td></tr>';
      fetch('api/all_car_routes.php?action=list')
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
            if ((it.imei || '').toLowerCase().indexOf(q) !== -1) return true;
            if ((it.car_name || '').toLowerCase().indexOf(q) !== -1) return true;
            if ((it.owner || '').toLowerCase().indexOf(q) !== -1) return true;
            if ((it.routes || []).some(r => (r.name || '').toLowerCase().indexOf(q) !== -1)) return true;
            return (it.zones || []).some(z => (z.name || '').toLowerCase().indexOf(q) !== -1);
         })
         : items;

      tbody.innerHTML = '';
      if (!list.length) {
         tbody.innerHTML = '<tr><td colspan="8" class="acr-empty">Нічого не знайдено</td></tr>';
         return;
      }

      list.forEach(it => {
         const tr = document.createElement('tr');
         const cnt = (it.routes || []).length;
         const badgeCls = 'acr-count-badge' + (cnt > 0 ? '' : ' empty');

         const routeChipItems = (it.routes || []).map(r => ({
            label: r.name ? r.name : ('#' + r.id + ' (видалений)'),
            chipClass: 'acr-route-chip',
            missing: !r.name,
         }));

         const zoneChipItems = (it.zones || []).map(z => ({
            label: z.name ? z.name : ('#' + z.id + ' (видалена)'),
            chipClass: zoneChipClass(z.type),
            missing: !z.name,
         }));

         tr.innerHTML =
            '<td class="col-imei">' + escapeHtml(it.imei || '') + '</td>' +
            '<td class="col-car">' + escapeHtml(it.car_name || '—') + '</td>' +
            '<td class="col-owner">' + escapeHtml(it.owner || '—') + '</td>' +
            '<td>' + buildChipsCellHtml(routeChipItems, {
               chipClass: 'acr-route-chip',
               missingClass: 'acr-route-chip missing',
               emptyClass: 'acr-route-chip missing',
               emptyLabel: '— немає —',
            }) + '</td>' +
            '<td>' + buildChipsCellHtml(zoneChipItems, {
               chipClass: 'acr-zone-chip',
               missingClass: 'acr-zone-chip missing',
               emptyClass: 'acr-zone-chip empty',
               emptyLabel: '— немає —',
            }) + '</td>' +
            '<td class="col-count"><span class="' + badgeCls + '">' + cnt + '</span></td>' +
            '<td class="col-date">' + escapeHtml(it.last_change_at || '') + '</td>' +
            '<td class="col-actions">' +
            '<button type="button" class="btn btn-secondary btn-small edit-btn">Редагувати</button> ' +
            '<button type="button" class="btn btn-danger btn-small detach-btn">Видалити</button>' +
            '</td>';

         tr.querySelector('.edit-btn').addEventListener('click', () => openModal(it));
         tr.querySelector('.detach-btn').addEventListener('click', () => doDetach(it));
         tbody.appendChild(tr);
      });
   }

   if (searchEl) searchEl.addEventListener('input', render);

   // =========================================
   // Видалення
   // =========================================
   function doDetach(it) {
      if (!confirm('Видалити прив\'язку IMEI ' + (it.imei || '#' + it.id) + '?')) return;
      const fd = new FormData();
      fd.append('action', 'detach');
      fd.append('id', it.id);
      fetch('api/all_car_routes.php', { method: 'POST', body: fd })
         .then(r => r.json())
         .then(j => {
            if (j.ok) loadList();
            else alert('Помилка: ' + (j.errors ? j.errors.join('; ') : (j.error || 'невідома')));
         })
         .catch(err => { console.error(err); alert('Мережева помилка'); });
   }

   // =========================================
   // Модалка
   // =========================================
   function updatePickedSummary() {
      pickedCountEl.textContent = '(обрано: ' + pickedIds.size + ')';
      pickedListEl.innerHTML = '';
      if (!pickedIds.size) return;

      Array.from(pickedIds).forEach(id => {
         const route = allRoutes.find(r => r.id === id);
         const label = route ? route.name : ('#' + id);
         const chip = document.createElement('span');
         chip.className = 'acr-picked-item';
         chip.innerHTML = escapeHtml(label) +
            '<button type="button" class="acr-picked-remove" title="Прибрати">×</button>';
         chip.querySelector('button').addEventListener('click', () => {
            pickedIds.delete(id);
            updatePickedSummary();
            renderRoutePicker(routeSearchEl.value);
         });
         pickedListEl.appendChild(chip);
      });
   }

   function renderRoutePicker(q) {
      q = (q || '').trim().toLowerCase();
      const routeList = q
         ? allRoutes.filter(r =>
            (r.name || '').toLowerCase().indexOf(q) !== -1 ||
            (r.group_name || '').toLowerCase().indexOf(q) !== -1)
         : allRoutes;

      routeListEl.innerHTML = '';
      if (!routeList.length) {
         routeListEl.innerHTML = '<div class="acr-picker-empty">Маршрутів не знайдено</div>';
         return;
      }

      routeList.forEach(r => {
         const item = document.createElement('div');
         const selected = pickedIds.has(r.id);
         item.className = 'acr-route-pick' + (selected ? ' selected' : '');
         item.dataset.id = r.id;
         item.innerHTML =
            '<div class="acr-route-pick-info">' +
            '<div class="acr-route-pick-name">' + escapeHtml(r.name || ('#' + r.id)) + '</div>' +
            (r.group_name ? '<div class="acr-route-pick-group">' + escapeHtml(r.group_name) + '</div>' : '') +
            '</div>' +
            '<div class="acr-route-pick-mark">✓</div>';
         item.addEventListener('click', () => {
            if (pickedIds.has(r.id)) pickedIds.delete(r.id);
            else pickedIds.add(r.id);
            item.classList.toggle('selected');
            updatePickedSummary();
         });
         routeListEl.appendChild(item);
      });
   }

   // =========================================
   // Пікер глобальних зон (final_stop | counting_ignoring)
   // =========================================
   function updatePickedZonesSummary() {
      pickedZonesCountEl.textContent = '(обрано: ' + pickedZoneIds.size + ')';
      pickedZonesListEl.innerHTML = '';
      if (!pickedZoneIds.size) return;

      Array.from(pickedZoneIds).forEach(id => {
         const zone = allZones.find(z => z.id === id);
         let label = zone ? zone.name : ('#' + id);
         if (zone && zone.type) {
            label += ' · ' + zoneTypeLabel(zone.type);
         }
         const chip = document.createElement('span');
         chip.className = 'acr-picked-item acr-picked-zone' +
            (zone && zone.type === 'counting_ignoring' ? ' acr-picked-zone--ignore' : '');
         chip.innerHTML = escapeHtml(label) +
            '<button type="button" class="acr-picked-remove" title="Прибрати">×</button>';
         chip.querySelector('button').addEventListener('click', () => {
            pickedZoneIds.delete(id);
            updatePickedZonesSummary();
            renderZonePicker(zoneSearchEl.value);
         });
         pickedZonesListEl.appendChild(chip);
      });
   }

   function renderZonePicker(q) {
      q = (q || '').trim().toLowerCase();
      const zoneList = q
         ? allZones.filter(z => (z.name || '').toLowerCase().indexOf(q) !== -1)
         : allZones;

      zoneListEl.innerHTML = '';
      if (!zoneList.length) {
         zoneListEl.innerHTML = '<div class="acr-picker-empty">Зон не знайдено</div>';
         return;
      }

      zoneList.forEach(z => {
         const item = document.createElement('div');
         const selected = pickedZoneIds.has(z.id);
         item.className = 'acr-route-pick' + (selected ? ' selected' : '') +
            (z.type === 'counting_ignoring' ? ' acr-route-pick--ignore-zone' : '');
         item.dataset.id = z.id;
         const metaParts = [];
         if (z.type) metaParts.push(zoneTypeLabel(z.type));
         metaParts.push((z.radius_m != null) ? ('радіус ' + z.radius_m + ' м') : 'полігон');
         const meta = metaParts.join(' · ');
         item.innerHTML =
            '<div class="acr-route-pick-info">' +
            '<div class="acr-route-pick-name">' + escapeHtml(z.name || ('#' + z.id)) + '</div>' +
            '<div class="acr-route-pick-group">' + escapeHtml(meta) + '</div>' +
            '</div>' +
            '<div class="acr-route-pick-mark">✓</div>';
         item.addEventListener('click', () => {
            if (pickedZoneIds.has(z.id)) pickedZoneIds.delete(z.id);
            else pickedZoneIds.add(z.id);
            item.classList.toggle('selected');
            updatePickedZonesSummary();
         });
         zoneListEl.appendChild(item);
      });
   }

   function openModal(it) {
      const isEdit = !!(it && it.id);
      editIdInput.value = isEdit ? String(it.id) : '';
      imeiInput.value = isEdit ? (it.imei || '') : '';
      routeSearchEl.value = '';
      zoneSearchEl.value = '';

      pickedIds = new Set();
      if (isEdit && Array.isArray(it.routes)) {
         it.routes.forEach(r => { if (r && r.id) pickedIds.add(Number(r.id)); });
      }

      pickedZoneIds = new Set();
      if (isEdit && Array.isArray(it.zones)) {
         it.zones.forEach(z => { if (z && z.id) pickedZoneIds.add(Number(z.id)); });
      }

      routeListEl.innerHTML = '<div class="acr-picker-empty">Завантаження маршрутів...</div>';
      pickedListEl.innerHTML = '';
      pickedCountEl.textContent = '(обрано: ' + pickedIds.size + ')';

      zoneListEl.innerHTML = '<div class="acr-picker-empty">Завантаження зон...</div>';
      pickedZonesListEl.innerHTML = '';
      pickedZonesCountEl.textContent = '(обрано: ' + pickedZoneIds.size + ')';

      if (modalTitleEl) {
         modalTitleEl.textContent = isEdit ? 'Редагувати маршрути машини' : modalTitleDefault;
      }
      if (saveBtn) saveBtn.textContent = isEdit ? 'Оновити' : 'Зберегти';

      modal.style.display = 'flex';

      fetch('api/all_car_routes.php?action=available_routes')
         .then(r => r.json())
         .then(data => {
            allRoutes = (data.routes || []).map(r => ({ ...r, id: Number(r.id) }));
            renderRoutePicker('');
            updatePickedSummary();
         })
         .catch(err => {
            console.error(err);
            routeListEl.innerHTML = '<div class="acr-picker-empty">Помилка завантаження</div>';
         });

      fetch('api/all_car_routes.php?action=available_zones')
         .then(r => r.json())
         .then(data => {
            allZones = (data.zones || []).map(z => ({ ...z, id: Number(z.id) }));
            renderZonePicker('');
            updatePickedZonesSummary();
         })
         .catch(err => {
            console.error(err);
            zoneListEl.innerHTML = '<div class="acr-picker-empty">Помилка завантаження</div>';
         });

      setTimeout(() => imeiInput.focus(), 50);
   }

   routeSearchEl.addEventListener('input', () => renderRoutePicker(routeSearchEl.value));
   zoneSearchEl.addEventListener('input', () => renderZonePicker(zoneSearchEl.value));

   function closeModal() {
      modal.style.display = 'none';
      if (modalTitleEl) modalTitleEl.textContent = modalTitleDefault;
   }

   addBtn.addEventListener('click', () => openModal(null));
   modalClose.addEventListener('click', closeModal);
   cancelBtn.addEventListener('click', closeModal);
   modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

   saveForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (isSaving) return;

      const imei = (imeiInput.value || '').trim();
      if (!imei) { alert('Введіть IMEI машини'); return; }
      if (!pickedIds.size && !pickedZoneIds.size) { alert('Оберіть хоча б одну зону або один маршрут'); return; }

      const editingId = parseInt(editIdInput.value || '0', 10);
      const existing = items.find(it => String(it.imei) === imei && it.id !== editingId);
      if (existing) {
         if (!confirm('IMEI ' + imei + ' вже має ' + (existing.routes || []).length + ' маршрут(ів). Замінити?')) return;
      }

      const fd = new FormData();
      fd.append('action', 'save');
      if (editingId) fd.append('id', String(editingId));
      fd.append('imei', imei);
      fd.append('routes_ids', JSON.stringify(Array.from(pickedIds)));
      fd.append('zones_ids', JSON.stringify(Array.from(pickedZoneIds)));

      isSaving = true;
      const orig = saveBtn.textContent;
      saveBtn.textContent = 'Збереження...';
      saveBtn.disabled = true;

      fetch('api/all_car_routes.php', { method: 'POST', body: fd })
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
