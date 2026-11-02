<?php
ini_set('error_reporting', E_ALL);
ini_set('display_errors', 0);
ini_set('display_startup_errors', 0);
date_default_timezone_set('Europe/Kiev');

require_once __DIR__ . '/../includes/auth.php';

$error = '';
$loginValue = '';

// Якщо вже авторизований - перенаправити
if (authCurrentUser()) {
   header('Location: ../Manager.php');
   exit;
}

// Обробка форми входу
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
   $loginValue = trim((string)($_POST['login'] ?? ''));
   $inputPassword = (string)($_POST['password'] ?? '');

   if ($loginValue === '' || $inputPassword === '') {
      $error = 'Введіть логін та пароль';
   } elseif (authLogin($loginValue, $inputPassword)) {
      header('Location: ../Manager.php');
      exit;
   } else {
      $error = 'Невірний логін або пароль';
   }
}
?>
<!doctype html>
<html lang="uk">

<head>
   <meta charset="utf-8">
   <title>Вхід - Консоль управління</title>
   <meta name="viewport" content="width=device-width,initial-scale=1">
   <link rel="stylesheet" href="../assets/css/styles.css">
   <style>
      .login-container {
         display: flex;
         justify-content: center;
         align-items: center;
         min-height: 100vh;
         padding: 20px;
      }

      .login-box {
         background: var(--panel);
         border: 1px solid var(--card-border);
         padding: 40px;
         border-radius: 12px;
         box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
         width: 100%;
         max-width: 400px;
      }

      .login-box h1 {
         margin: 0 0 30px 0;
         color: var(--accent);
         font-size: 24px;
         text-align: center;
      }

      .login-box .form-group {
         margin-bottom: 20px;
      }

      .login-box label {
         display: block;
         margin-bottom: 8px;
         color: var(--text);
         font-weight: 600;
      }

      .login-box input[type="text"],
      .login-box input[type="password"] {
         width: 100%;
         padding: 12px;
         border-radius: 6px;
         border: 1px solid var(--border);
         background: var(--input-bg);
         color: var(--text);
         font-size: 14px;
         box-sizing: border-box;
      }

      .login-box input[type="text"]:focus,
      .login-box input[type="password"]:focus {
         outline: none;
         border-color: var(--accent);
      }

      .login-box .error {
         color: #ff6b6b;
         margin-top: 10px;
         font-size: 14px;
      }

      .login-box .btn {
         width: 100%;
         padding: 12px;
         margin-top: 10px;
      }
   </style>
</head>

<body>
   <div class="login-container">
      <div class="login-box">
         <h1>Вхід до консолі</h1>
         <form method="POST" action="">
            <div class="form-group">
               <label for="login">Логін</label>
               <input type="text" id="login" name="login" required autocomplete="username"
                  value="<?= htmlspecialchars($loginValue, ENT_QUOTES, 'UTF-8') ?>" <?= $loginValue === '' ? 'autofocus' : '' ?>>
            </div>
            <div class="form-group">
               <label for="password">Пароль</label>
               <input type="password" id="password" name="password" required autocomplete="current-password" <?= $loginValue !== '' ? 'autofocus' : '' ?>>
            </div>
            <?php if ($error): ?>
               <div class="error"><?= htmlspecialchars($error, ENT_QUOTES, 'UTF-8') ?></div>
            <?php endif; ?>
            <button type="submit" class="btn">Увійти</button>
         </form>
      </div>
   </div>
</body>

</html>
