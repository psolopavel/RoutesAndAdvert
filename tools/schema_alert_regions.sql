-- Статичний довідник регіонів для мапінгу тривог alerts.in.ua → офіційні межі COD-AB
-- База: RoutesAndAdvertisement (db2)

CREATE TABLE IF NOT EXISTS alert_regions (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    -- Неофіційний UID з alerts.in.ua / UID_ALL_GROMADS.json
    alert_uid           VARCHAR(16)  NOT NULL,
    -- oblast | raion | hromada | city
    alert_level         ENUM('oblast','raion','hromada','city') NOT NULL,

    name_uk             VARCHAR(255) NOT NULL,
    oblast_name         VARCHAR(255) NULL,
    raion_name          VARCHAR(255) NULL,

    -- Офіційний COD-AB pcode (UA48, UA4802, UA4802001)
    official_pcode      VARCHAR(16)  NULL,
    admin_level         TINYINT UNSIGNED NOT NULL COMMENT '1=oblast, 2=raion, 3=hromada',

    -- Для швидкого відображення / fallback без ST_Contains
    centroid_lat        DECIMAL(10,7) NULL,
    centroid_lon        DECIMAL(10,7) NULL,

    -- Повна геометрія меж (MariaDB / MySQL spatial, без SRID у DDL)
    geom                MULTIPOLYGON NOT NULL,

    match_method        ENUM('exact','parent_context','old_name','alias','manual','unmatched') NOT NULL DEFAULT 'exact',
    match_notes         VARCHAR(255) NULL,

    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uq_alert_uid_level (alert_uid, alert_level),
    KEY idx_official_pcode (official_pcode),
    KEY idx_admin_level (admin_level),
    SPATIAL INDEX idx_geom (geom)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Кеш активних тривог (оновлюється cron/daemon кожні 15-30 сек)
CREATE TABLE IF NOT EXISTS active_alerts (
    id                  BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'id з alerts API',
    alert_type          VARCHAR(32)  NOT NULL,
    alert_uid           VARCHAR(16)  NOT NULL,
    alert_level         ENUM('oblast','raion','hromada','city') NOT NULL,
    location_title      VARCHAR(255) NOT NULL,
    started_at          DATETIME NOT NULL,
    updated_at          DATETIME NOT NULL,

    region_id           INT UNSIGNED NULL COMMENT 'FK alert_regions.id, якщо знайдено',

    KEY idx_region (region_id),
    KEY idx_alert_uid (alert_uid, alert_level),
    KEY idx_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Поле для кешування поточної громади машини (щоб PHP не робив ST_Contains)
ALTER TABLE tracking_sessions
  ADD COLUMN IF NOT EXISTS current_region_id INT UNSIGNED NULL
    COMMENT 'FK alert_regions.id — громада, в якій зараз машина';
