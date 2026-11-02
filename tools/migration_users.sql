-- =============================================
-- Користувачі консолі, їхні IMEI та маршрути, сесії входу.
-- Виконати один раз у базі RoutesAndAdvertisement.
-- Після міграції створити першого адміністратора:
--   php tools/create_admin.php <login> <password>
-- =============================================

CREATE TABLE IF NOT EXISTS users (
   id            INT(11)      NOT NULL AUTO_INCREMENT,
   login         VARCHAR(64)  NOT NULL,
   password_hash VARCHAR(255) NOT NULL,
   role          ENUM('admin', 'routes_track', 'advertisement', 'client') NOT NULL DEFAULT 'client',
   display_name  VARCHAR(128) NULL DEFAULT NULL,
   active        TINYINT(1)   NOT NULL DEFAULT 1,
   created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
   last_login_at DATETIME     NULL DEFAULT NULL,
   PRIMARY KEY (id),
   UNIQUE KEY uniq_users_login (login)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Один IMEI належить лише одному користувачу
CREATE TABLE IF NOT EXISTS user_imeis (
   user_id    INT(11)     NOT NULL,
   imei       VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
   created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
   PRIMARY KEY (user_id, imei),
   UNIQUE KEY uniq_user_imeis_imei (imei),
   CONSTRAINT fk_user_imeis_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Один маршрут належить лише одному користувачу
CREATE TABLE IF NOT EXISTS user_routes (
   user_id    INT(11)  NOT NULL,
   route_id   INT(11)  NOT NULL,
   created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
   PRIMARY KEY (user_id, route_id),
   UNIQUE KEY uniq_user_routes_route (route_id),
   CONSTRAINT fk_user_routes_user  FOREIGN KEY (user_id)  REFERENCES users (id)  ON DELETE CASCADE,
   CONSTRAINT fk_user_routes_route FOREIGN KEY (route_id) REFERENCES routes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Сесії входу: у cookie лежить випадковий токен, у БД — лише його sha256
CREATE TABLE IF NOT EXISTS user_sessions (
   token_hash   CHAR(64)     CHARACTER SET ascii NOT NULL,
   user_id      INT(11)      NOT NULL,
   created_at   DATETIME     NOT NULL,
   expires_at   DATETIME     NOT NULL,
   last_seen_at DATETIME     NOT NULL,
   ip           VARCHAR(45)  NULL DEFAULT NULL,
   user_agent   VARCHAR(255) NULL DEFAULT NULL,
   PRIMARY KEY (token_hash),
   KEY idx_user_sessions_user (user_id),
   KEY idx_user_sessions_expires (expires_at),
   CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Власник реклами. NULL — стара/спільна реклама (видима лише admin та advertisement)
ALTER TABLE advertisement
   ADD COLUMN owner_user_id INT(11) NULL DEFAULT NULL AFTER file,
   ADD KEY idx_advertisement_owner (owner_user_id);
