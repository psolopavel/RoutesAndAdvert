document.addEventListener('DOMContentLoaded', function () {
   const tabsEl = document.getElementById('a2rTabs');
   const routesListEl = document.getElementById('a2rRoutesList');
   const searchEl = document.getElementById('a2rRouteSearch');
   const titleEl = document.getElementById('a2rRouteTitle');
   const subtitleEl = document.getElementById('a2rRouteSubtitle');
   const emptyEl = document.getElementById('a2rEmpty');
   const contentEl = document.getElementById('a2rContent');

   // Time block
   const startInput = document.getElementById('a2rStart');
   const endInput = document.getElementById('a2rEnd');
   const intervalSelect = document.getElementById('a2rInterval');
   const slotsCountEl = document.getElementById('a2rSlotsCount');
   const rotationListEl = document.getElementById('a2rRotationList');
   const addRotationBtn = document.getElementById('a2rAddRotationBtn');
   const gridPreviewEl = document.getElementById('a2rGridPreview');
   const saveScheduleBtn = document.getElementById('a2rSaveScheduleBtn');
   const timeBlockSub = document.getElementById('a2rTimeBlockSub');

   // Zone block
   const zoneListEl = document.getElementById('a2rZoneList');
   const addZoneBtn = document.getElementById('a2rAddZoneBtn');
   const zoneBlockSub = document.getElementById('a2rZoneBlockSub');

   // Pick modal (rotation / override)
   const pickModal = document.getElementById('a2rPickModal');
   const pickTitle = document.getElementById('a2rPickTitle');
   const pickClose = document.getElementById('a2rPickClose');
   const pickCancel = document.getElementById('a2rPickCancel');
   const pickSave = document.getElementById('a2rPickSave');
   const pickPicker = document.getElementById('a2rPickPicker');
   const pickAdId = document.getElementById('a2rPickAdId');
   const pickDpe = document.getElementById('a2rPickDpe');

   // Zone modal
   const zoneModal = document.getElementById('a2rZoneModal');
   const zoneModalTitle = document.getElementById('a2rZoneTitle');
   const zoneClose = document.getElementById('a2rZoneClose');
   const zoneCancel = document.getElementById('a2rZoneCancel');
   const zoneSave = document.getElementById('a2rZoneSave');
   const zonePicker = document.getElementById('a2rZonePicker');
   const zoneAdId = document.getElementById('a2rZoneAdId');
   const zoneSelect = document.getElementById('a2rZoneSelect');
   const zoneDpe = document.getElementById('a2rZoneDpe');
   const zoneEditId = document.getElementById('a2rZoneEditId');

   const imageExtRe = /\.(jpg|jpeg|png|gif|webp)$/i;
   const PALETTE = ['#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ef4444', '#14b8a6', '#eab308', '#ec4899', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16'];

   let groups = [];
   let activeGroupId = null;
   let currentRouteId = null;
   let currentRoute = null;
   let searchQuery = '';
   let adsCache = null;

   // Стан часового блоку
   let rotation = [];          // [{advert_id, display_per_event, advert_name, advert_file}]
   let overrides = {};         // { slotMin: {advert_id, display_per_event, advert_name, advert_file} }

   // Стан модалки вибору
   let pickMode = null;        // 'rotation' | 'override'
   let pickSlotMin = null;

   function escapeHtml(s) {
      return String(s == null ? '' : s)
         .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
         .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
   }

   function mediaTag(file, alt) {
      if (!file) return '<div class="a2r-advert-no-media">Немає файлу</div>';
      const url = 'videos/' + file;
      if (imageExtRe.test(file)) {
         return '<img src="' + url + '" alt="' + escapeHtml(alt || '') + '" />';
      }
      return '<video muted loop autoplay playsinline><source src="' + url + '"></video>';
   }

   function advertColor(id) {
      return PALETTE[((id % PALETTE.length) + PALETTE.length) % PALETTE.length];
   }

   const pad2 = n => String(n).padStart(2, '0');

   function timeInputToMin(v) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(v || '');
      if (!m) return null;
      return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
   }

   function minToTimeInput(min) {
      const m = ((min % 1440) + 1440) % 1440;
      return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
   }

   // =========================================
   // Загрузка груп та маршрутів
   // =========================================
   function loadGroups() {
      fetch('api/advert_to_route.php?action=list_groups_with_routes')
         .then(r => r.json())
         .then(data => {
            if (data.error) { alert(data.error); return; }
            groups = data.groups || [];
            renderTabs();
            renderRoutes();
         })
         .catch(err => { console.error(err); alert('Помилка завантаження маршрутів'); });
   }

   function renderTabs() {
      tabsEl.innerHTML = '';
      const totalRoutes = groups.reduce((s, g) => s + (g.routes ? g.routes.length : 0), 0);

      const allTab = document.createElement('div');
      allTab.className = 'a2r-tab' + (activeGroupId === null ? ' active' : '');
      allTab.innerHTML = 'Всі <span class="a2r-tab-count">(' + totalRoutes + ')</span>';
      allTab.addEventListener('click', () => { activeGroupId = null; renderTabs(); renderRoutes(); });
      tabsEl.appendChild(allTab);

      groups.forEach(g => {
         const t = document.createElement('div');
         t.className = 'a2r-tab' + (activeGroupId === g.id ? ' active' : '');
         t.innerHTML = escapeHtml(g.name) + ' <span class="a2r-tab-count">(' + (g.routes ? g.routes.length : 0) + ')</span>';
         t.addEventListener('click', () => { activeGroupId = g.id; renderTabs(); renderRoutes(); });
         tabsEl.appendChild(t);
      });
   }

   function getVisibleRoutes() {
      const q = searchQuery.trim().toLowerCase();
      let list = [];
      groups.forEach(g => {
         if (activeGroupId !== null && g.id !== activeGroupId) return;
         (g.routes || []).forEach(r => {
            list.push(Object.assign({}, r, { _group_name: g.name }));
         });
      });
      if (q) {
         list = list.filter(r => (r.name || '').toLowerCase().indexOf(q) !== -1);
      }
      return list;
   }

   function renderRoutes() {
      const list = getVisibleRoutes();
      routesListEl.innerHTML = '';
      if (list.length === 0) {
         routesListEl.innerHTML = '<div class="a2r-empty">Маршрутів не знайдено</div>';
         return;
      }
      list.forEach(r => {
         const item = document.createElement('div');
         item.className = 'a2r-route-item' + (currentRouteId === r.id ? ' active' : '');
         const cnt = r.adverts_count || 0;
         const badgeCls = 'a2r-route-badge' + (cnt > 0 ? '' : ' empty');
         item.innerHTML =
            '<div>' +
            '<div class="a2r-route-name">' + escapeHtml(r.name || ('#' + r.id)) + '</div>' +
            '<div class="a2r-route-meta">' + escapeHtml(r._group_name || '') +
            (r.length_m ? ' • ' + r.length_m + ' м' : '') + '</div>' +
            '</div>' +
            '<span class="' + badgeCls + '" title="Прив\'язано записів">' + cnt + '</span>';
         item.addEventListener('click', () => selectRoute(r));
         routesListEl.appendChild(item);
      });
   }

   if (searchEl) {
      searchEl.addEventListener('input', () => {
         searchQuery = searchEl.value || '';
         renderRoutes();
      });
   }

   function updateRouteAdvertsCount(routeId, count) {
      for (const g of groups) {
         for (const r of (g.routes || [])) {
            if (r.id === routeId) {
               r.adverts_count = count;
               renderRoutes();
               return;
            }
         }
      }
   }

   // =========================================
   // Вибір маршруту
   // =========================================
   function selectRoute(route) {
      currentRouteId = route.id;
      currentRoute = route;
      titleEl.textContent = route.name || ('Маршрут #' + route.id);
      subtitleEl.textContent = (route._group_name || '') + (route.length_m ? ' • ' + route.length_m + ' м' : '');
      emptyEl.style.display = 'none';
      contentEl.style.display = '';
      renderRoutes();
      loadTimeSchedule();
      loadZoneAdverts();
   }

   // =========================================
   // Часовий блок: завантаження
   // =========================================
   function loadTimeSchedule() {
      rotation = [];
      overrides = {};
      rotationListEl.innerHTML = '<div class="a2r-empty">Завантаження...</div>';
      gridPreviewEl.innerHTML = '<div class="a2r-empty">Завантаження...</div>';

      fetch('api/advert_to_route.php?action=get_time_schedule&route_id=' + currentRouteId)
         .then(r => r.json())
         .then(data => {
            if (data.error) { alert(data.error); return; }
            const sch = data.schedule;
            if (sch) {
               startInput.value = minToTimeInput(sch.start_min);
               endInput.value = minToTimeInput(sch.end_min);
               intervalSelect.value = String(sch.interval_min);
            }
            rotation = (data.rotation || []).map(x => ({
               advert_id: x.advert_id,
               display_per_event: x.display_per_event || 1,
               advert_name: x.advert_name,
               advert_file: x.advert_file,
            }));
            overrides = {};
            (data.overrides || []).forEach(o => {
               overrides[o.slot_min] = {
                  advert_id: o.advert_id,
                  display_per_event: o.display_per_event || 1,
                  advert_name: o.advert_name,
                  advert_file: o.advert_file,
               };
            });
            renderRotation();
            renderGrid();
         })
         .catch(err => { console.error(err); alert('Помилка завантаження розкладу'); });
   }

   function computeSlots() {
      const start = timeInputToMin(startInput.value);
      const end = timeInputToMin(endInput.value);
      const interval = parseInt(intervalSelect.value, 10);
      if (start === null || end === null || !interval || end <= start) return [];
      const slots = [];
      for (let m = start; m <= end; m += interval) {
         slots.push(m);
         if (slots.length > 2000) break;
      }
      return slots;
   }

   function renderRotation() {
      rotationListEl.innerHTML = '';
      if (!rotation.length) {
         rotationListEl.innerHTML = '<div class="a2r-empty">Цикл порожній</div>';
         return;
      }
      rotation.forEach((it, idx) => {
         const color = advertColor(it.advert_id);
         const card = document.createElement('div');
         card.className = 'a2r-rot-item';
         card.style.borderLeftColor = color;
         card.innerHTML =
            '<span class="a2r-rot-pos">' + (idx + 1) + '</span>' +
            '<div class="a2r-rot-media">' + mediaTag(it.advert_file, it.advert_name) + '</div>' +
            '<div class="a2r-rot-info">' +
            '<div class="a2r-rot-name">' + escapeHtml(it.advert_name || ('#' + it.advert_id)) + '</div>' +
            '<label class="a2r-rot-dpe">Показів: ' +
            '<input type="number" class="input a2r-dpe-input" min="1" step="1" value="' + (it.display_per_event || 1) + '">' +
            '</label>' +
            '</div>' +
            '<div class="a2r-rot-actions">' +
            '<button type="button" class="btn-icon a2r-move-up" title="Вгору">↑</button>' +
            '<button type="button" class="btn-icon a2r-move-down" title="Вниз">↓</button>' +
            '<button type="button" class="btn-icon a2r-rot-del" title="Прибрати">×</button>' +
            '</div>';

         card.querySelector('.a2r-dpe-input').addEventListener('change', (e) => {
            it.display_per_event = Math.max(1, parseInt(e.target.value, 10) || 1);
            e.target.value = it.display_per_event;
         });
         card.querySelector('.a2r-move-up').addEventListener('click', () => {
            if (idx > 0) { rotation.splice(idx - 1, 0, rotation.splice(idx, 1)[0]); renderRotation(); renderGrid(); }
         });
         card.querySelector('.a2r-move-down').addEventListener('click', () => {
            if (idx < rotation.length - 1) { rotation.splice(idx + 1, 0, rotation.splice(idx, 1)[0]); renderRotation(); renderGrid(); }
         });
         card.querySelector('.a2r-rot-del').addEventListener('click', () => {
            rotation.splice(idx, 1); renderRotation(); renderGrid();
         });

         rotationListEl.appendChild(card);
      });
   }

   function slotAdvert(slotIndex, slotMin) {
      if (overrides[slotMin]) return { entry: overrides[slotMin], manual: true };
      if (rotation.length) return { entry: rotation[slotIndex % rotation.length], manual: false };
      return null;
   }

   function renderGrid() {
      const slots = computeSlots();
      slotsCountEl.textContent = slots.length + ' слотів';
      timeBlockSub.textContent = rotation.length
         ? (rotation.length + ' у циклі • ' + slots.length + ' слотів')
         : 'не налаштовано';

      if (!slots.length) {
         gridPreviewEl.innerHTML = '<div class="a2r-empty">Задайте коректні часи та інтервал</div>';
         return;
      }
      if (!rotation.length && !Object.keys(overrides).length) {
         gridPreviewEl.innerHTML = '<div class="a2r-empty">Додайте рекламу в цикл</div>';
         return;
      }

      const frag = document.createDocumentFragment();
      slots.forEach((slotMin, i) => {
         const info = slotAdvert(i, slotMin);
         const cell = document.createElement('div');
         cell.className = 'a2r-cell' + (info && info.manual ? ' manual' : '');
         if (info) {
            const color = advertColor(info.entry.advert_id);
            cell.style.borderLeftColor = color;
            cell.innerHTML =
               '<span class="a2r-cell-time">' + minToTimeInput(slotMin) + '</span>' +
               '<span class="a2r-cell-name" style="color:' + color + '">' +
               escapeHtml(info.entry.advert_name || ('#' + info.entry.advert_id)) + '</span>' +
               (info.manual ? '<span class="a2r-cell-badge">ручна</span>' : '');
         } else {
            cell.classList.add('empty');
            cell.innerHTML = '<span class="a2r-cell-time">' + minToTimeInput(slotMin) + '</span><span class="a2r-cell-name">—</span>';
         }
         cell.addEventListener('click', () => openPickModal('override', slotMin));
         frag.appendChild(cell);
      });
      gridPreviewEl.innerHTML = '';
      gridPreviewEl.appendChild(frag);
   }

   // Перемальовуємо сітку при зміні конфігу
   [startInput, endInput, intervalSelect].forEach(el => {
      el.addEventListener('change', renderGrid);
      el.addEventListener('input', renderGrid);
   });

   // =========================================
   // Реклама: кеш + пікер
   // =========================================
   function fetchAds() {
      if (adsCache) return Promise.resolve(adsCache);
      return fetch('api/advert_to_route.php?action=available_ads')
         .then(r => r.json())
         .then(d => { adsCache = d.ads || []; return adsCache; });
   }

   function findAd(id) {
      if (!adsCache) return null;
      return adsCache.find(a => String(a.id) === String(id)) || null;
   }

   function renderAdsPicker(container, hiddenInput, selectedId) {
      container.innerHTML = '<div class="a2r-empty">Завантаження...</div>';
      hiddenInput.value = selectedId ? String(selectedId) : '';
      fetchAds().then(ads => {
         container.innerHTML = '';
         if (!ads.length) { container.innerHTML = '<div class="a2r-empty">Немає реклами</div>'; return; }
         ads.forEach(ad => {
            const el = document.createElement('div');
            el.className = 'a2r-ad-pick';
            el.dataset.id = ad.id;
            el.innerHTML =
               '<div class="a2r-ad-pick-media">' + mediaTag(ad.file, ad.name) + '</div>' +
               '<div class="a2r-ad-pick-name" title="' + escapeHtml(ad.name || '') + '">' +
               escapeHtml(ad.name || ad.file || ('#' + ad.id)) + '</div>';
            if (selectedId && String(ad.id) === String(selectedId)) el.classList.add('selected');
            el.addEventListener('click', () => {
               container.querySelectorAll('.a2r-ad-pick.selected').forEach(n => n.classList.remove('selected'));
               el.classList.add('selected');
               hiddenInput.value = ad.id;
            });
            container.appendChild(el);
         });
      });
   }

   // =========================================
   // Модалка вибору реклами (rotation / override)
   // =========================================
   function openPickModal(mode, slotMin) {
      pickMode = mode;
      pickSlotMin = slotMin != null ? slotMin : null;

      let selected = null;
      let dpe = 1;
      if (mode === 'override' && overrides[slotMin]) {
         selected = overrides[slotMin].advert_id;
         dpe = overrides[slotMin].display_per_event || 1;
      } else if (mode === 'override' && rotation.length) {
         const slots = computeSlots();
         const idx = slots.indexOf(slotMin);
         if (idx >= 0) { selected = rotation[idx % rotation.length].advert_id; }
      }

      pickTitle.textContent = mode === 'rotation'
         ? 'Додати рекламу в цикл'
         : ('Реклама для ' + minToTimeInput(slotMin) + ' (UTC+3)');
      pickSave.textContent = mode === 'rotation' ? 'Додати' : 'Застосувати';
      pickDpe.value = dpe;

      // Кнопка скидання overrides (лише в режимі override, якщо є override)
      let resetBtn = document.getElementById('a2rPickReset');
      if (mode === 'override' && overrides[slotMin]) {
         if (!resetBtn) {
            resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.id = 'a2rPickReset';
            resetBtn.className = 'btn btn-secondary';
            resetBtn.textContent = 'Повернути з циклу';
            resetBtn.addEventListener('click', () => {
               delete overrides[pickSlotMin];
               closePickModal();
               renderGrid();
            });
            pickCancel.parentNode.insertBefore(resetBtn, pickCancel);
         }
         resetBtn.style.display = '';
      } else if (resetBtn) {
         resetBtn.style.display = 'none';
      }

      renderAdsPicker(pickPicker, pickAdId, selected);
      pickModal.style.display = 'flex';
   }

   function closePickModal() {
      pickModal.style.display = 'none';
      pickMode = null;
      pickSlotMin = null;
   }

   pickClose.addEventListener('click', closePickModal);
   pickCancel.addEventListener('click', closePickModal);
   pickModal.addEventListener('click', (e) => { if (e.target === pickModal) closePickModal(); });
   addRotationBtn.addEventListener('click', () => openPickModal('rotation', null));

   pickSave.addEventListener('click', () => {
      const adId = parseInt(pickAdId.value, 10);
      if (!adId) { alert('Виберіть рекламу'); return; }
      const ad = findAd(adId);
      const dpe = Math.max(1, parseInt(pickDpe.value, 10) || 1);
      const entry = {
         advert_id: adId,
         display_per_event: dpe,
         advert_name: ad ? ad.name : ('#' + adId),
         advert_file: ad ? ad.file : '',
      };
      if (pickMode === 'rotation') {
         rotation.push(entry);
      } else if (pickMode === 'override' && pickSlotMin != null) {
         overrides[pickSlotMin] = entry;
      }
      closePickModal();
      renderRotation();
      renderGrid();
   });

   // =========================================
   // Збереження розкладу
   // =========================================
   saveScheduleBtn.addEventListener('click', () => {
      const start = timeInputToMin(startInput.value);
      const end = timeInputToMin(endInput.value);
      const interval = parseInt(intervalSelect.value, 10);
      if (start === null || end === null) { alert('Вкажіть коректні часи'); return; }
      if (end <= start) { alert('Час завершення має бути пізніше за початок'); return; }

      const slots = computeSlots();
      const slotSet = new Set(slots);
      const ovList = [];
      Object.keys(overrides).forEach(k => {
         const slotMin = parseInt(k, 10);
         if (!slotSet.has(slotMin)) return; // override поза межами сітки — ігноруємо
         ovList.push({
            slot_min: slotMin,
            advert_id: overrides[k].advert_id,
            display_per_event: overrides[k].display_per_event || 1,
         });
      });

      const payload = {
         action: 'save_time_schedule',
         route_id: currentRouteId,
         start_min: start,
         end_min: end,
         interval_min: interval,
         rotation: rotation.map(r => ({ advert_id: r.advert_id, display_per_event: r.display_per_event || 1 })),
         overrides: ovList,
      };

      const orig = saveScheduleBtn.textContent;
      saveScheduleBtn.disabled = true;
      saveScheduleBtn.textContent = 'Збереження...';

      fetch('api/advert_to_route.php?action=save_time_schedule', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify(payload),
      })
         .then(r => r.json())
         .then(j => {
            if (j.ok) {
               saveScheduleBtn.textContent = 'Збережено ✓';
               setTimeout(() => { saveScheduleBtn.textContent = orig; }, 1500);
               loadTimeSchedule();
               loadZoneAdverts(); // оновити лічильник
            } else {
               alert('Помилка: ' + (j.errors ? j.errors.join('; ') : (j.error || 'невідома')));
               saveScheduleBtn.textContent = orig;
            }
         })
         .catch(err => { console.error(err); alert('Мережева помилка'); saveScheduleBtn.textContent = orig; })
         .finally(() => { saveScheduleBtn.disabled = false; });
   });

   // =========================================
   // Зональний блок
   // =========================================
   function loadZoneAdverts() {
      zoneListEl.innerHTML = '<div class="a2r-empty-large">Завантаження...</div>';
      fetch('api/advert_to_route.php?action=route_adverts&route_id=' + currentRouteId)
         .then(r => r.json())
         .then(data => {
            if (data.error) { alert(data.error); return; }
            const items = data.items || [];
            updateRouteAdvertsCount(currentRouteId, items.length);
            const zoneItems = items.filter(it => it.binding_type === 'zone');
            renderZoneAdverts(zoneItems);
         })
         .catch(err => { console.error(err); alert('Помилка завантаження зон'); });
   }

   function renderZoneAdverts(items) {
      zoneBlockSub.textContent = items.length ? (items.length + ' прив\'язок') : 'немає';
      zoneListEl.innerHTML = '';
      if (!items.length) {
         zoneListEl.innerHTML = '<div class="a2r-empty-large">Немає прив\'язок за зоною</div>';
         return;
      }
      items.forEach(it => {
         const card = document.createElement('div');
         card.className = 'a2r-advert-card';
         card.innerHTML =
            '<div class="a2r-advert-media">' + mediaTag(it.advert_file, it.advert_name) + '</div>' +
            '<div class="a2r-advert-body">' +
            '<h4 class="a2r-advert-name">' + escapeHtml(it.advert_name || 'Без назви') + '</h4>' +
            '<div class="a2r-info-row">' +
            '<span class="a2r-info-label"><span class="a2r-binding-tag binding-zone">Зона</span></span>' +
            '<span class="a2r-info-value">' + escapeHtml(it.zone_name || ('#' + it.zone_id)) + '</span>' +
            '</div>' +
            '<div class="a2r-info-row">' +
            '<span class="a2r-info-label">Показів за подію:</span>' +
            '<span class="a2r-info-value">' + (it.display_per_event || 1) + '</span>' +
            '</div>' +
            '</div>' +
            '<div class="a2r-advert-actions">' +
            '<button type="button" class="btn btn-secondary edit-btn">Редагувати</button>' +
            '<button type="button" class="btn btn-danger detach-btn">Видалити</button>' +
            '</div>';

         card.querySelector('.detach-btn').addEventListener('click', () => doDetach(it.id, it.advert_name));
         card.querySelector('.edit-btn').addEventListener('click', () => openZoneModal(it));
         zoneListEl.appendChild(card);
      });
   }

   function doDetach(id, name) {
      if (!confirm('Видалити прив\'язку "' + (name || ('#' + id)) + '"?')) return;
      const fd = new FormData();
      fd.append('action', 'detach');
      fd.append('id', id);
      fetch('api/advert_to_route.php', { method: 'POST', body: fd })
         .then(r => r.json())
         .then(j => {
            if (j.ok) loadZoneAdverts();
            else alert('Помилка: ' + (j.errors ? j.errors.join('; ') : (j.error || 'невідома')));
         })
         .catch(err => { console.error(err); alert('Мережева помилка'); });
   }

   // Зональна модалка
   function openZoneModal(it) {
      if (!currentRouteId) return;
      const isEdit = !!(it && it.id);
      zoneEditId.value = isEdit ? it.id : '';
      zoneModalTitle.textContent = isEdit ? 'Редагувати прив\'язку за зоною' : 'Додати рекламу до зони';
      zoneSave.textContent = isEdit ? 'Оновити' : 'Зберегти';
      zoneDpe.value = isEdit && it.display_per_event ? String(it.display_per_event) : '1';

      renderAdsPicker(zonePicker, zoneAdId, isEdit ? it.advert_id : null);
      loadRouteZones(isEdit ? it.zone_id : null);
      zoneModal.style.display = 'flex';
   }

   function closeZoneModal() {
      zoneModal.style.display = 'none';
   }

   function loadRouteZones(selectedZoneId) {
      zoneSelect.innerHTML = '<option value="">— виберіть зону —</option>';
      fetch('api/advert_to_route.php?action=route_zones&route_id=' + currentRouteId)
         .then(r => r.json())
         .then(data => {
            const zones = data.zones || [];
            zones.forEach(z => {
               const opt = document.createElement('option');
               opt.value = z.id;
               opt.textContent = z.name + (z.radius_m ? ' (R=' + z.radius_m + 'м)' : '');
               zoneSelect.appendChild(opt);
            });
            if (selectedZoneId) zoneSelect.value = String(selectedZoneId);
            if (!zones.length) {
               const opt = document.createElement('option');
               opt.value = '';
               opt.textContent = '— у маршруту немає рекламних зон —';
               opt.disabled = true;
               zoneSelect.appendChild(opt);
            }
         })
         .catch(err => console.error(err));
   }

   addZoneBtn.addEventListener('click', (e) => { e.stopPropagation(); openZoneModal(null); });
   zoneClose.addEventListener('click', closeZoneModal);
   zoneCancel.addEventListener('click', closeZoneModal);
   zoneModal.addEventListener('click', (e) => { if (e.target === zoneModal) closeZoneModal(); });

   zoneSave.addEventListener('click', () => {
      if (!zoneAdId.value) { alert('Виберіть рекламу'); return; }
      if (!zoneSelect.value) { alert('Виберіть зону'); return; }
      const isEdit = !!zoneEditId.value;

      const fd = new FormData();
      fd.append('action', isEdit ? 'update' : 'attach');
      if (isEdit) fd.append('id', zoneEditId.value);
      fd.append('route_id', currentRouteId);
      fd.append('advert_id', zoneAdId.value);
      fd.append('binding_type', 'zone');
      fd.append('zone_id', zoneSelect.value);
      fd.append('display_per_event', zoneDpe.value || '1');

      const orig = zoneSave.textContent;
      zoneSave.disabled = true;
      zoneSave.textContent = 'Збереження...';

      fetch('api/advert_to_route.php', { method: 'POST', body: fd })
         .then(r => r.json())
         .then(j => {
            if (j.ok) { closeZoneModal(); loadZoneAdverts(); }
            else alert('Помилка: ' + (j.errors ? j.errors.join('; ') : (j.error || 'невідома')));
         })
         .catch(err => { console.error(err); alert('Мережева помилка'); })
         .finally(() => { zoneSave.disabled = false; zoneSave.textContent = orig; });
   });

   // =========================================
   // Згортання блоків
   // =========================================
   document.querySelectorAll('.a2r-block-header[data-collapse]').forEach(header => {
      header.addEventListener('click', () => {
         const body = document.getElementById(header.dataset.collapse);
         const collapsed = header.classList.toggle('collapsed');
         if (body) body.style.display = collapsed ? 'none' : '';
      });
   });

   // ініціалізація
   loadGroups();
});
