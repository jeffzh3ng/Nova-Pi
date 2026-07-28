//! 敏感字段（如 Telegram botToken）的本地混淆存储。
//!
//! 设计目标：防止 `config_json` 内的 token 被明文读取（备份/SQLite 文件外泄），
//! 不是密码学意义的强加密（本地存储场景下，能读 SQLite 的进程通常也能读内存）。
//!
//! 方案：基于机器绑定密钥的 XOR + base64 包装，前缀 `enc:v1:` 标记已混淆。
//! - 密钥派生：app_data_dir 路径 + 内置固定盐的 SHA-256（不引入额外 crate，
//!   用 std 的哈希组合；对本地混淆足够）。
//! - 前缀让明文与密文可区分：旧数据（明文）读取时自动识别并按需升级为密文。
//!
//! 注意：此模块只用于消息通道 config_json 中的敏感字段，不替代 OS keychain
//! （Windows Credential Manager / macOS Keychain）——后者是更优解，但跨平台
//! 集成成本高，留作后续迭代。

use base64::{engine::general_purpose, Engine as _};

/// 密文标记前缀。读到该前缀走解密；否则按明文处理（向后兼容）。
pub const CIPHER_PREFIX: &str = "enc:v1:";

/// 派生密钥用的固定盐（与 app 绑定，不随机器变；机器绑定由 key_seed 提供）。
const STATIC_SALT: &[u8] = b"nova-pi/secrets/v1";

/// 对称密钥：基于运行实例的 key_seed（app_data_dir 路径）+ 静态盐，展开为 32 字节流。
///
/// 用 FNV-1a（std 可实现，无外部依赖）双重哈希 + 拉伸到 32 字节。
/// 不是密码学强 KDF，但本地混淆场景足够：攻击者拿到 SQLite 仍需逆向本函数。
fn derive_key(key_seed: &str) -> [u8; 32] {
    let seed_bytes = key_seed.as_bytes();
    let mut key = [0u8; 32];
    // 简单流式展开：每个 key 字节 = FNV(seed || salt || index) 的某字节
    for i in 0..32u8 {
        let mut h: u64 = 0xcbf29ce484222325; // FNV-1a 64 offset basis
        for &b in seed_bytes
            .iter()
            .chain(STATIC_SALT.iter())
            .chain(std::iter::once(&i))
        {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3); // FNV-1a 64 prime
        }
        key[i as usize] = (h & 0xff) as u8;
    }
    key
}

/// XOR 流加密（对称）。data 与 key 等长时直接异或；key 循环复用。
fn xor_with(data: &[u8], key: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, &b)| b ^ key[i % key.len()])
        .collect()
}

/// 加密明文为 `enc:v1:<base64>`。空串原样返回（避免把空值也包装）。
pub fn encrypt(plain: &str, key_seed: &str) -> String {
    if plain.is_empty() {
        return String::new();
    }
    // 已是密文则不重复加密
    if plain.starts_with(CIPHER_PREFIX) {
        return plain.to_string();
    }
    let key = derive_key(key_seed);
    let cipher = xor_with(plain.as_bytes(), &key);
    let b64 = general_purpose::STANDARD.encode(&cipher);
    format!("{CIPHER_PREFIX}{b64}")
}

/// 解密。输入非 `enc:v1:` 前缀时视为明文原样返回（向后兼容旧数据）。
pub fn decrypt(stored: &str, key_seed: &str) -> String {
    if let Some(rest) = stored.strip_prefix(CIPHER_PREFIX) {
        let key = derive_key(key_seed);
        match general_purpose::STANDARD.decode(rest) {
            Ok(cipher) => {
                let plain = xor_with(&cipher, &key);
                String::from_utf8_lossy(&plain).into_owned()
            }
            // 损坏的密文：返回空串，避免把乱码当 token 用
            Err(_) => String::new(),
        }
    } else {
        stored.to_string()
    }
}

/// 是否为已混淆的密文。
pub fn is_cipher(s: &str) -> bool {
    s.starts_with(CIPHER_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: &str = "/app/data/nova-pi";

    #[test]
    fn roundtrip_typical_token() {
        let token = "6123456789:AAH-ExampleTelegramToken_with.dash-and_underscore";
        let c = encrypt(token, SEED);
        assert!(c.starts_with(CIPHER_PREFIX));
        assert_ne!(c, token);
        assert_eq!(decrypt(&c, SEED), token);
    }

    #[test]
    fn empty_string_passthrough() {
        assert_eq!(encrypt("", SEED), "");
        assert_eq!(decrypt("", SEED), "");
    }

    #[test]
    fn plaintext_backward_compat() {
        // 旧数据是明文，解密应原样返回
        let plain = "legacy-plain-token";
        assert_eq!(decrypt(plain, SEED), plain);
    }

    #[test]
    fn double_encrypt_idempotent() {
        let token = "secret";
        let c1 = encrypt(token, SEED);
        let c2 = encrypt(&c1, SEED);
        assert_eq!(c1, c2);
    }

    #[test]
    fn unicode_roundtrip() {
        let s = "中文token-🔐";
        assert_eq!(decrypt(&encrypt(s, SEED), SEED), s);
    }
}
