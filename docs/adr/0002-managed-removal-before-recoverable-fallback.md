# Prefer managed removal before recoverable fallback

Lampwright will use an available Owner's supported lifecycle operation before touching its artifacts directly. A failed Managed Removal stops before a separately confirmed Brute-force Removal, and brute-force filesystem changes go to a 30-day Quarantine so the tool can remain useful across unsupported installers without making uncertain deletion irreversible.
