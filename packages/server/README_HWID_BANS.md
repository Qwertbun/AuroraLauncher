# HWID Ban Integration (Launcher + LauncherServer)

## Важно
Правильная архитектура:
1. Лаунчер собирает fingerprint устройства (`hwid`) и отправляет в `auth`.
2. LauncherServer проверяет `hwid` в MySQL.
3. Если HWID заблокирован, сервер возвращает ошибку авторизации.

## Что уже сделано в лаунчере
- Добавлен `DeviceFingerprintService` на базе `systeminformation`.
- В `auth` отправляются дополнительные поля:
  - `hwid` (SHA-256 fingerprint)
  - `hwidVersion` (`v1`)

## Рекомендованная SQL схема (MySQL 5.7)

```sql
CREATE TABLE IF NOT EXISTS launcher_hwid_bans (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    hwid_hash CHAR(64) NOT NULL,
    user_id INT(11) NULL,
    reason VARCHAR(255) NULL,
    expires_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(64) NULL,
    PRIMARY KEY (id),
    KEY idx_hwid_hash (hwid_hash),
    KEY idx_user_id (user_id),
    KEY idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Если в `users` другой PK, адаптируйте `user_id`.

Для автосохранения HWID добавьте таблицу:

```sql
CREATE TABLE IF NOT EXISTS launcher_hwid_seen (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(64) NOT NULL,
    user_uuid CHAR(36) NOT NULL,
    hwid_hash CHAR(64) NOT NULL,
    hwid_version VARCHAR(16) NULL,
    first_seen_at DATETIME NOT NULL,
    last_seen_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_user_hwid (user_uuid, hwid_hash),
    KEY idx_hwid_hash (hwid_hash),
    KEY idx_last_seen_at (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## Серверная проверка (LauncherServer)
Псевдологика:
1. Принять `auth(login, password, hwid, hwidVersion)`.
2. Выполнить обычную проверку логина/пароля.
3. Проверить `hwid` в `launcher_hwid_bans`:
   - `hwid_hash = ?`
   - и `(expires_at IS NULL OR expires_at > NOW())`
4. Если найдено — вернуть ошибку `HWID_BANNED`.
5. Иначе завершить авторизацию как обычно.

## Автосохранение HWID (встроено в DatabaseAuthProvider)
- Работает только при `auth.type = "db"`.
- После успешной проверки логина/пароля и проверки бана сервер сохраняет `hwid` в `launcher_hwid_seen`.
- Если пара (`user_uuid`, `hwid_hash`) уже есть, обновляется `last_seen_at`.
- Если таблица недоступна/отсутствует, сервер отключает трекинг HWID и продолжает логин без падения.

Пример запроса для бана по последнему HWID пользователя:

```sql
INSERT INTO launcher_hwid_bans (hwid_hash, user_id, reason, expires_at, created_by)
SELECT s.hwid_hash, u.user_id, 'manual ban', NULL, 'admin'
FROM launcher_hwid_seen s
LEFT JOIN users u ON u.name = s.username
WHERE s.username = ?
ORDER BY s.last_seen_at DESC
LIMIT 1;
```

## Практика безопасности
- Хранить только хеш (`hwid_hash`), не хранить сырой fingerprint.
- Вести аудит: кто/когда выдал бан, причина.
- Поддерживать апелляцию и soft-ban процесс.
