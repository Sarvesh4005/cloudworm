from cloudworm.config import CHUNK_BYTES, GCM_TAG_BYTES, Settings, chunk_count, ciphertext_size, encrypted_part_size


def test_chunk_math_matches_frontend_protocol():
    assert CHUNK_BYTES == 8 * 1024 * 1024
    assert chunk_count(0) == 1  # empty files still produce one authenticated chunk
    assert chunk_count(1) == 1
    assert chunk_count(CHUNK_BYTES) == 1
    assert chunk_count(CHUNK_BYTES + 1) == 2
    assert ciphertext_size(0) == GCM_TAG_BYTES
    assert ciphertext_size(CHUNK_BYTES + 1) == CHUNK_BYTES + 1 + 2 * GCM_TAG_BYTES


def test_part_sizes_sum_to_ciphertext_size():
    for size in [0, 5, CHUNK_BYTES, CHUNK_BYTES * 3 + 17]:
        parts = chunk_count(size)
        assert sum(encrypted_part_size(size, n) for n in range(1, parts + 1)) == ciphertext_size(size)
        # S3 requires every part except the last to be >= 5 MiB.
        for n in range(1, parts):
            assert encrypted_part_size(size, n) >= 5 * 1024 * 1024


def test_settings_parse_lists(monkeypatch):
    monkeypatch.setenv("EXPIRY_HOURS_OPTIONS", "72, 1,24")
    monkeypatch.setenv("DEFAULT_EXPIRY_HOURS", "999")
    monkeypatch.setenv("ALLOWED_EXTENSIONS", ".PDF, png")
    s = Settings.from_env()
    assert s.expiry_hours_options == [1, 24, 72]
    assert s.default_expiry_hours == 1  # invalid default falls back to first option
    assert s.allowed_extensions == ["pdf", "png"]
