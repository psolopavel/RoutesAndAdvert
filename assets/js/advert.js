document.addEventListener('DOMContentLoaded', function () {
   const wrap = document.getElementById('adsWrap');
   const rightPanel = document.getElementById('rightPanel');
   const adsList = document.getElementById('adsList');
   const videoPreview = document.getElementById('videoPreview');
   const adForm = document.getElementById('adForm');
   const addAdBtn = document.getElementById('addAdBtn');
   const cancelBtn = document.getElementById('cancelBtn');
   const saveBtn = document.getElementById('saveBtn');
   const adNameInput = document.getElementById('adNameInput');
   const videoInput = document.getElementById('videoInput');
   const videoDropzone = document.getElementById('videoDropzone');
   const videoFileName = document.getElementById('videoFileName');
   const formTitle = document.getElementById('formTitle');
   const adIdInput = document.getElementById('adIdInput');
   const actionInput = adForm.querySelector('input[name="action"]');

   let isSaving = false;
   let editingAd = null; // null = режим створення, інакше — об'єкт реклами, що редагується

   // --------- Дроп-зона для відео / фото ---------
   const MAX_SIZE = 100 * 1024 * 1024;
   const allowedExt = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'jpg', 'jpeg', 'png', 'gif', 'webp'];
   const imageExtRe = /\.(jpg|jpeg|png|gif|webp)$/i;

   function setFileName(file) {
      if (!videoFileName) return;
      const f = file || (videoInput.files && videoInput.files[0]);
      videoFileName.textContent = f ? f.name : '';
   }

   let currentPreviewUrl = null;
   function clearPreview() {
      if (!videoPreview) return;
      if (currentPreviewUrl) {
         try { URL.revokeObjectURL(currentPreviewUrl); } catch (e) { }
         currentPreviewUrl = null;
      }
      videoPreview.innerHTML = '';
      videoPreview.style.display = 'none';
   }

   function showPreview(file) {
      if (!videoPreview || !file) return;
      clearPreview();
      const url = URL.createObjectURL(file);
      currentPreviewUrl = url;
      const isImage = (file.type && file.type.indexOf('image/') === 0)
         || imageExtRe.test(file.name || '');
      let el;
      if (isImage) {
         el = document.createElement('img');
         el.src = url;
         el.alt = file.name || '';
      } else {
         el = document.createElement('video');
         el.src = url;
         el.muted = true;
         el.loop = true;
         el.autoplay = true;
         el.playsInline = true;
         el.controls = true;
      }
      videoPreview.appendChild(el);
      videoPreview.style.display = 'flex';
   }

   function validateAndSetFile(file) {
      if (!file) return false;
      const name = file.name || '';
      const ext = name.indexOf('.') !== -1 ? name.split('.').pop().toLowerCase() : '';

      if (allowedExt.indexOf(ext) === -1) {
         alert('Підтримуються тільки відео (mp4, mov, webm, mkv, avi) та зображення (jpg, jpeg, png, gif, webp)');
         return false;
      }
      if ((file.size || 0) > MAX_SIZE) {
         alert('Файл завеликий. Максимальний розмір 100 МБ');
         return false;
      }

      try {
         const dt = new DataTransfer();
         dt.items.add(file);
         videoInput.files = dt.files;
      } catch (err) {
         console.warn('Не вдалося оновити files для input', err);
      }
      setFileName(file);
      showPreview(file);
      return true;
   }

   if (videoDropzone && videoInput) {
      videoDropzone.addEventListener('click', function (e) {
         // Не відкривати file picker, якщо клікнули по медіа-прев'ю (наприклад, по контролах відео)
         if (videoPreview && videoPreview.contains(e.target)) return;
         videoInput.click();
      });

      videoInput.addEventListener('change', function () {
         const file = videoInput.files && videoInput.files[0];
         if (!validateAndSetFile(file)) {
            videoInput.value = '';
            if (videoFileName) videoFileName.textContent = '';
            clearPreview();
         }
      });

      ['dragenter', 'dragover'].forEach(function (evt) {
         videoDropzone.addEventListener(evt, function (e) {
            e.preventDefault();
            e.stopPropagation();
            videoDropzone.classList.add('dragover');
         });
      });

      ['dragleave', 'dragend', 'drop'].forEach(function (evt) {
         videoDropzone.addEventListener(evt, function (e) {
            e.preventDefault();
            e.stopPropagation();
            videoDropzone.classList.remove('dragover');
         });
      });

      videoDropzone.addEventListener('drop', function (e) {
         const files = e.dataTransfer.files;
         if (files && files.length > 0) {
            if (!validateAndSetFile(files[0])) {
               if (videoFileName) videoFileName.textContent = '';
            }
         }
      });
   }

   function hideRight() {
      rightPanel.setAttribute('aria-hidden', 'true');
      if (wrap) wrap.classList.add('expanded');
   }
   function showRight() {
      rightPanel.removeAttribute('aria-hidden');
      if (wrap) wrap.classList.remove('expanded');
   }
   hideRight();

   function resetForm() {
      adForm.reset();
      if (videoInput) videoInput.value = '';
      if (videoFileName) videoFileName.textContent = '';
      clearPreview();
      if (saveBtn) {
         saveBtn.textContent = 'Зберегти';
         saveBtn.disabled = false;
      }
      editingAd = null;
      if (adIdInput) adIdInput.value = '';
      if (actionInput) actionInput.value = 'add_ad';
      if (formTitle) formTitle.textContent = 'Нова реклама';
   }

   // Показати існуючий файл у прев'ю (для режиму редагування — без перезавантаження)
   function showExistingPreview(fileName) {
      if (!videoPreview || !fileName) return;
      clearPreview();
      const url = 'videos/' + fileName;
      const isImage = imageExtRe.test(fileName);
      let el;
      if (isImage) {
         el = document.createElement('img');
         el.src = url;
         el.alt = fileName;
      } else {
         el = document.createElement('video');
         el.src = url;
         el.muted = true;
         el.loop = true;
         el.autoplay = true;
         el.playsInline = true;
         el.controls = true;
      }
      videoPreview.appendChild(el);
      videoPreview.style.display = 'flex';
   }

   function startEdit(ad) {
      resetForm();
      editingAd = ad;
      if (actionInput) actionInput.value = 'update_ad';
      if (adIdInput) adIdInput.value = ad.id;
      if (formTitle) formTitle.textContent = 'Редагування реклами';
      if (adNameInput) adNameInput.value = ad.name || '';
      if (videoFileName) videoFileName.textContent = ad.file || '';
      if (saveBtn) saveBtn.textContent = 'Зберегти зміни';
      showExistingPreview(ad.file);
      showRight();
      window.scrollTo({ top: 0, behavior: 'smooth' });
   }

   // =============================================
   // Завантаження списку реклами
   // =============================================
   function fetchAds() {
      fetch('api/ads.php?action=list')
         .then(function (r) { return r.json(); })
         .then(function (data) {
            if (data.error) { alert(data.error); return; }
            renderAds(data.ads || []);
         })
         .catch(function (e) {
            console.error(e);
            alert('Помилка отримання даних');
         });
   }

   function formatDate(dt) {
      if (!dt) return '';
      // Очікуємо формат "YYYY-MM-DD HH:MM:SS"
      return String(dt).replace('T', ' ').substring(0, 16);
   }

   function renderAds(ads) {
      adsList.innerHTML = '';
      if (!ads || ads.length === 0) {
         adsList.innerHTML = '<div class="small" style="padding:20px; text-align:center; font-size:18px;">Немає реклами</div>';
         return;
      }

      const container = document.createElement('div');
      container.className = 'ads-grid';

      ads.forEach(function (ad) {
         const div = document.createElement('div');
         div.className = 'ad-card';
         div.dataset.id = ad.id;

         const adName = ad.name || ad.file || 'Без назви';
         const fileUrl = ad.file ? 'videos/' + ad.file : '';
         const isImage = fileUrl && imageExtRe.test(fileUrl);

         const mediaHtml = fileUrl
            ? (isImage
               ? '<img src="' + fileUrl + '" alt="' + escapeHtml(adName) + '" />'
               : '<video muted loop autoplay playsinline><source src="' + fileUrl + '"></video>')
            : '<div class="no-video">Немає файлу</div>';

         div.innerHTML =
            '<div class="ad-card-header">' +
               '<div class="ad-card-title">' + escapeHtml(adName) + '</div>' +
            '</div>' +
            '<div class="ad-card-video">' + mediaHtml + '</div>' +
            '<div class="ad-card-body">' +
               '<div class="ad-card-info">' +
                  '<div class="info-row"><span class="info-label">Файл:</span><span class="info-value">' + escapeHtml(ad.file || '-') + '</span></div>' +
                  '<div class="info-row"><span class="info-label">Дата:</span><span class="info-value">' + escapeHtml(formatDate(ad.created_at)) + '</span></div>' +
               '</div>' +
            '</div>' +
            '<div class="ad-card-actions">' +
               '<button type="button" class="btn edit-btn">Редагувати</button>' +
               '<button type="button" class="btn delete-btn">Видалити</button>' +
            '</div>';

         const editBtn = div.querySelector('.edit-btn');
         if (editBtn) editBtn.addEventListener('click', function () { startEdit(ad); });
         const delBtn = div.querySelector('.delete-btn');
         if (delBtn) delBtn.addEventListener('click', function () { doDelete(ad.id, adName); });

         container.appendChild(div);
      });

      adsList.appendChild(container);
   }

   function escapeHtml(s) {
      return String(s == null ? '' : s)
         .replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')
         .replace(/>/g, '&gt;')
         .replace(/"/g, '&quot;')
         .replace(/'/g, '&#39;');
   }

   // =============================================
   // Створення реклами (форма)
   // =============================================
   if (addAdBtn) {
      addAdBtn.addEventListener('click', function () {
         resetForm();
         showRight();
         window.scrollTo({ top: 0, behavior: 'smooth' });
      });
   }

   if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
         resetForm();
         hideRight();
      });
   }

   adForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (isSaving) return;

      const isEdit = !!editingAd;

      const errors = [];
      if (!adNameInput || !adNameInput.value.trim()) {
         errors.push('Введіть назву реклами');
      }
      // Файл обов'язковий тільки при створенні
      if (!isEdit && (!videoInput || !videoInput.files || !videoInput.files[0])) {
         errors.push('Виберіть відео або фото файл');
      }

      if (errors.length > 0) {
         alert('Помилки валідації:\n' + errors.join('\n'));
         return;
      }

      const formData = new FormData(adForm);
      formData.set('action', isEdit ? 'update_ad' : 'add_ad');
      // Якщо редагуємо і файл не вибрано — приберемо порожній video_file з payload
      if (isEdit && (!videoInput || !videoInput.files || !videoInput.files[0])) {
         formData.delete('video_file');
      }

      isSaving = true;
      const originalText = saveBtn.textContent;
      saveBtn.textContent = 'Збереження...';
      saveBtn.disabled = true;

      fetch('api/ads.php', { method: 'POST', body: formData })
         .then(function (r) { return r.json(); })
         .then(function (data) {
            if (data.ok) {
               resetForm();
               hideRight();
               fetchAds();
            } else {
               alert('Помилка: ' + (data.errors ? data.errors.join('; ') : (data.error || 'невідома помилка')));
            }
         })
         .catch(function (err) {
            console.error(err);
            alert('Мережева помилка');
         })
         .finally(function () {
            isSaving = false;
            saveBtn.disabled = false;
            saveBtn.textContent = originalText;
         });
   });

   // =============================================
   // Видалення
   // =============================================
   function doDelete(adId, adName) {
      if (!confirm('Видалити рекламу "' + (adName || ('#' + adId)) + '"?')) return;

      const fd = new FormData();
      fd.append('action', 'delete_ad');
      fd.append('id', adId);

      fetch('api/ads.php', { method: 'POST', body: fd })
         .then(function (r) { return r.json(); })
         .then(function (j) {
            if (j.ok) {
               fetchAds();
            } else {
               alert('Помилка видалення: ' + (j.errors ? j.errors.join('; ') : 'невідома помилка'));
            }
         })
         .catch(function (err) {
            console.error(err);
            alert('Мережева помилка');
         });
   }

   // початкове завантаження
   fetchAds();
});
