<?php
// Цей файл включається в Manager.php, тому сесія та $db, $db2 вже доступні
?>

<div class="wrap expanded" id="adsWrap">
   <div class="left-panel">
      <div class="block">
         <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <strong class="AddAdsTxt" style="margin:0;">Реклама</strong>
            <button id="addAdBtn" class="btn">Додати рекламу</button>
         </div>
         <div id="adsList" class="ads-list"></div>
      </div>
   </div>

   <div class="right-panel" id="rightPanel" aria-hidden="true">
      <div class="block">
         <strong id="formTitle" class="AddAdsTxt" style="display:block; margin-bottom:16px;">Нова реклама</strong>
         <form id="adForm" enctype="multipart/form-data">
            <input type="hidden" name="action" value="add_ad">
            <input type="hidden" name="ad_id" id="adIdInput" value="">

            <div class="row" style="margin-top:12px">
               <label class="form-label">Назва реклами</label>
               <input id="adNameInput" type="text" name="ad_name" class="input" placeholder="Введіть назву реклами" />
            </div>

            <div class="row" style="margin-top:12px">
               <label class="form-label">Відео / Фото файл</label>
               <div id="videoDropzone" class="file-dropzone">
                  <div class="file-dropzone-inner">
                     <div class="file-dropzone-icon">⬆</div>
                     <div class="file-dropzone-text">
                        <div>Перетягніть відео або фото сюди</div>
                        <div class="file-dropzone-subtext">або натисніть, щоб вибрати файл (відео / зображення, до 100 МБ)</div>
                     </div>
                  </div>
                  <div id="videoPreview" class="file-dropzone-preview" style="display:none;"></div>
               </div>
               <input id="videoInput" type="file" name="video_file" accept="video/*,image/*" style="display:none" />
            </div>
            <div class="row" style="margin-top:4px">
               <span id="maxSizeWarn">(макс. 100 МБ)</span>
               <span id="videoFileName" class="small"></span>
            </div>

            <div class="row" style="margin-top:20px">
               <button type="submit" id="saveBtn" class="btn">Зберегти</button>
               <button type="button" id="cancelBtn" class="btn">Скасувати</button>
            </div>
         </form>
      </div>
   </div>
</div>

<script src="assets/js/advert.js"></script>
