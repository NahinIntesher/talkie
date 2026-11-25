-- Runs once, when the MySQL volume is first created. The entrypoint has already created the `talkie` user
-- (MYSQL_USER / MYSQL_PASSWORD_FILE); give it every per-service database (talkie_auth, talkie_chat, …) and nothing else.
GRANT ALL PRIVILEGES ON `talkie\_%`.* TO 'talkie'@'%';
FLUSH PRIVILEGES;
