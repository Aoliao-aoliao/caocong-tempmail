CREATE TABLE IF NOT EXISTS relay_account_addresses (
relay_account_id BIGINT UNSIGNED NOT NULL,
address VARCHAR(320) COLLATE utf8mb4_0900_ai_ci NOT NULL,
created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
PRIMARY KEY(relay_account_id,address), UNIQUE KEY uq_relay_routing_address(address),
CONSTRAINT fk_relay_routing_account FOREIGN KEY(relay_account_id) REFERENCES relay_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
