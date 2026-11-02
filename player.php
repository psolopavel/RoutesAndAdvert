<?php
$imei = isset($_GET['imei']) ? $_GET['imei'] : '';
if (!$imei) {
    die("Укажіть imei в параметрі URL, наприклад: ?imei=354018114690435");
}
?>
<!doctype html>
<html lang="en">

<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Плеер IMEI <?= htmlspecialchars($imei) ?></title>
    <link rel="stylesheet" href="assets/css/player.css">
    <style>
        html,
        body {
            cursor: none !important;
        }
    </style>
</head>

<body>

    <div id="AdditionalInfo">
        <div id="TimeNow">--:--</div>
        <div id="nextStop"></div>
        <div id="weather"></div>
    </div>

    <div id="routeContainer" aria-hidden="false"></div>
    <div id="log_container" aria-live="polite">
        <div class="log-section-title">Майбутні зупинки: </div>
        <div id="log">
            <div id="log-future" class="log-list"></div>
        </div>
    </div>

    <div id="adContainer">
        <div id="adLoadingIndicator" style="display: none;">
            <div class="loading-spinner"></div>
            <div class="loading-text">Завантаження реклами...</div>
        </div>
        <video
            id="adVideo"
            playsinline
            webkit-playsinline
            muted
            preload="auto"></video>
        <img id="adImage" style="display: none;" />
    </div>

    <div id="noSignalOverlay">
        <div id="noSignalText">No Signal</div>
    </div>

</body>
<script>
    const imei = '<?php echo $imei ?>'
</script>
<script src="assets/js/player.js"></script>

</html>