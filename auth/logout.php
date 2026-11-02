<?php
require_once __DIR__ . '/../includes/auth.php';
authLogout();
header('Location: login.php');
exit;
