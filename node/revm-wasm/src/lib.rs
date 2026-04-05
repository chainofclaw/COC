use revm::{
    primitives::{
        Address, Bytes, ExecutionResult as RevmExecutionResult, Log, Output, TxKind,
        U256, SpecId, AccountInfo, Bytecode, KECCAK_EMPTY,
    },
    db::InMemoryDB,
    Evm,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use std::str::FromStr;

#[derive(Serialize, Deserialize)]
pub struct TxParams {
    pub from: String,
    pub to: Option<String>,
    pub value: Option<String>,
    pub data: Option<String>,
    pub gas_limit: Option<u64>,
    pub gas_price: Option<String>,
    pub nonce: Option<u64>,
}

#[derive(Serialize, Deserialize)]
pub struct ExecutionResultJs {
    pub success: bool,
    pub gas_used: String,
    pub output: String,
    pub logs: Vec<LogJs>,
    pub created_address: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct LogJs {
    pub address: String,
    pub topics: Vec<String>,
    pub data: String,
}

#[derive(Serialize, Deserialize)]
pub struct AccountInfoJs {
    pub balance: String,
    pub nonce: String,
    pub code_hash: String,
}

#[wasm_bindgen]
pub struct RevmInstance {
    db: InMemoryDB,
    chain_id: u64,
    spec_id: SpecId,
}

#[wasm_bindgen]
impl RevmInstance {
    #[wasm_bindgen(constructor)]
    pub fn new(chain_id: u64, spec_id_str: &str) -> RevmInstance {
        let spec_id = match spec_id_str.to_uppercase().as_str() {
            "SHANGHAI" => SpecId::SHANGHAI,
            "CANCUN" => SpecId::CANCUN,
            "PRAGUE" => SpecId::PRAGUE,
            _ => SpecId::SHANGHAI,
        };
        RevmInstance {
            db: InMemoryDB::default(),
            chain_id,
            spec_id,
        }
    }

    #[wasm_bindgen(js_name = setBalance)]
    pub fn set_balance(&mut self, address: &str, balance: &str) -> Result<(), JsValue> {
        let addr = Address::from_str(address)
            .map_err(|e| JsValue::from_str(&format!("invalid address: {}", e)))?;
        let bal = U256::from_str(balance)
            .map_err(|e| JsValue::from_str(&format!("invalid balance: {}", e)))?;
        let info = AccountInfo {
            balance: bal,
            nonce: self.db.accounts.get(&addr).map_or(0, |a| a.info.nonce),
            code_hash: self.db.accounts.get(&addr).map_or(KECCAK_EMPTY, |a| a.info.code_hash),
            code: self.db.accounts.get(&addr).and_then(|a| a.info.code.clone()),
        };
        self.db.insert_account_info(addr, info);
        Ok(())
    }

    #[wasm_bindgen(js_name = getBalance)]
    pub fn get_balance(&self, address: &str) -> Result<String, JsValue> {
        let addr = Address::from_str(address)
            .map_err(|e| JsValue::from_str(&format!("invalid address: {}", e)))?;
        let balance = self.db.accounts.get(&addr)
            .map_or(U256::ZERO, |a| a.info.balance);
        Ok(balance.to_string())
    }

    #[wasm_bindgen(js_name = getNonce)]
    pub fn get_nonce(&self, address: &str) -> Result<String, JsValue> {
        let addr = Address::from_str(address)
            .map_err(|e| JsValue::from_str(&format!("invalid address: {}", e)))?;
        let nonce = self.db.accounts.get(&addr).map_or(0u64, |a| a.info.nonce);
        Ok(nonce.to_string())
    }

    #[wasm_bindgen(js_name = setAccount)]
    pub fn set_account(&mut self, address: &str, balance: &str, nonce: u64, code_hex: &str) -> Result<(), JsValue> {
        let addr = Address::from_str(address)
            .map_err(|e| JsValue::from_str(&format!("invalid address: {}", e)))?;
        let bal = U256::from_str(balance)
            .map_err(|e| JsValue::from_str(&format!("invalid balance: {}", e)))?;
        let code = if code_hex.is_empty() || code_hex == "0x" {
            None
        } else {
            let hex_str = code_hex.strip_prefix("0x").unwrap_or(code_hex);
            Some(Bytecode::new_raw(Bytes::from(hex::decode(hex_str).unwrap_or_default())))
        };
        let info = AccountInfo {
            balance: bal,
            nonce,
            code_hash: code.as_ref().map_or(KECCAK_EMPTY, |c| c.hash_slow()),
            code,
        };
        self.db.insert_account_info(addr, info);
        Ok(())
    }

    #[wasm_bindgen(js_name = getCode)]
    pub fn get_code(&self, address: &str) -> Result<String, JsValue> {
        let addr = Address::from_str(address)
            .map_err(|e| JsValue::from_str(&format!("invalid address: {}", e)))?;
        match self.db.accounts.get(&addr) {
            Some(acc) => match &acc.info.code {
                Some(code) => Ok(format!("0x{}", hex::encode(code.bytes()))),
                None => Ok("0x".to_string()),
            },
            None => Ok("0x".to_string()),
        }
    }

    /// Execute a transaction and commit state changes
    #[wasm_bindgen(js_name = transact)]
    pub fn transact(&mut self, params_json: &str) -> Result<String, JsValue> {
        let params: TxParams = serde_json::from_str(params_json)
            .map_err(|e| JsValue::from_str(&format!("invalid params: {}", e)))?;

        let from = Address::from_str(&params.from)
            .map_err(|e| JsValue::from_str(&format!("invalid from: {}", e)))?;

        let to = match &params.to {
            Some(to_str) if !to_str.is_empty() => {
                TxKind::Call(Address::from_str(to_str)
                    .map_err(|e| JsValue::from_str(&format!("invalid to: {}", e)))?)
            }
            _ => TxKind::Create,
        };

        let value = params.value.as_deref()
            .map(|v| U256::from_str(v).unwrap_or(U256::ZERO))
            .unwrap_or(U256::ZERO);

        let data = params.data.as_deref()
            .map(|d| {
                let hex_str = d.strip_prefix("0x").unwrap_or(d);
                Bytes::from(hex::decode(hex_str).unwrap_or_default())
            })
            .unwrap_or_default();

        let gas_limit = params.gas_limit.unwrap_or(30_000_000);
        let gas_price = params.gas_price.as_deref()
            .map(|p| U256::from_str(p).unwrap_or(U256::ZERO))
            .unwrap_or(U256::ZERO);

        let nonce = params.nonce.unwrap_or_else(|| {
            self.db.accounts.get(&from).map_or(0, |a| a.info.nonce)
        });

        let mut evm = Evm::builder()
            .with_db(&mut self.db)
            .modify_cfg_env(|cfg| {
                cfg.chain_id = self.chain_id;
            })
            .modify_tx_env(|tx| {
                tx.caller = from;
                tx.transact_to = to;
                tx.value = value;
                tx.data = data;
                tx.gas_limit = gas_limit;
                tx.gas_price = gas_price;
                tx.nonce = Some(nonce);
            })
            .with_spec_id(self.spec_id)
            .build();

        let result = evm.transact_commit()
            .map_err(|e| JsValue::from_str(&format!("execution error: {}", e)))?;

        let result_js = match result {
            RevmExecutionResult::Success { gas_used, output, logs, .. } => {
                let (output_data, created_address) = match output {
                    Output::Call(data) => (data, None),
                    Output::Create(data, addr) => (data, addr.map(|a| format!("0x{:x}", a))),
                };
                ExecutionResultJs {
                    success: true,
                    gas_used: gas_used.to_string(),
                    output: format!("0x{}", hex::encode(&output_data)),
                    logs: logs.iter().map(|l| convert_log(l)).collect(),
                    created_address,
                }
            }
            RevmExecutionResult::Revert { gas_used, output } => {
                ExecutionResultJs {
                    success: false,
                    gas_used: gas_used.to_string(),
                    output: format!("0x{}", hex::encode(&output)),
                    logs: vec![],
                    created_address: None,
                }
            }
            RevmExecutionResult::Halt { gas_used, .. } => {
                ExecutionResultJs {
                    success: false,
                    gas_used: gas_used.to_string(),
                    output: format!("0x"),
                    logs: vec![],
                    created_address: None,
                }
            }
        };

        serde_json::to_string(&result_js)
            .map_err(|e| JsValue::from_str(&format!("serialization error: {}", e)))
    }

    /// Execute without committing (eth_call equivalent)
    #[wasm_bindgen(js_name = staticCall)]
    pub fn static_call(&mut self, params_json: &str) -> Result<String, JsValue> {
        let params: TxParams = serde_json::from_str(params_json)
            .map_err(|e| JsValue::from_str(&format!("invalid params: {}", e)))?;

        let from_str = if params.from.is_empty() { "0x0000000000000000000000000000000000000000" } else { &params.from };
        let from = Address::from_str(from_str)
            .map_err(|e| JsValue::from_str(&format!("invalid from: {}", e)))?;

        let to = match &params.to {
            Some(to_str) if !to_str.is_empty() => {
                TxKind::Call(Address::from_str(to_str)
                    .map_err(|e| JsValue::from_str(&format!("invalid to: {}", e)))?)
            }
            _ => TxKind::Create,
        };

        let value = params.value.as_deref()
            .map(|v| U256::from_str(v).unwrap_or(U256::ZERO))
            .unwrap_or(U256::ZERO);

        let data = params.data.as_deref()
            .map(|d| {
                let hex_str = d.strip_prefix("0x").unwrap_or(d);
                Bytes::from(hex::decode(hex_str).unwrap_or_default())
            })
            .unwrap_or_default();

        let gas_limit = params.gas_limit.unwrap_or(30_000_000);

        let mut evm = Evm::builder()
            .with_db(&mut self.db)
            .modify_cfg_env(|cfg| {
                cfg.chain_id = self.chain_id;
            })
            .modify_tx_env(|tx| {
                tx.caller = from;
                tx.transact_to = to;
                tx.value = value;
                tx.data = data;
                tx.gas_limit = gas_limit;
            })
            .with_spec_id(self.spec_id)
            .build();

        let result = evm.transact()
            .map_err(|e| JsValue::from_str(&format!("execution error: {}", e)))?;

        let result_js = match result.result {
            RevmExecutionResult::Success { gas_used, output, logs, .. } => {
                let (output_data, created_address) = match output {
                    Output::Call(data) => (data, None),
                    Output::Create(data, addr) => (data, addr.map(|a| format!("0x{:x}", a))),
                };
                ExecutionResultJs {
                    success: true,
                    gas_used: gas_used.to_string(),
                    output: format!("0x{}", hex::encode(&output_data)),
                    logs: logs.iter().map(|l| convert_log(l)).collect(),
                    created_address,
                }
            }
            RevmExecutionResult::Revert { gas_used, output } => {
                ExecutionResultJs {
                    success: false,
                    gas_used: gas_used.to_string(),
                    output: format!("0x{}", hex::encode(&output)),
                    logs: vec![],
                    created_address: None,
                }
            }
            RevmExecutionResult::Halt { gas_used, .. } => {
                ExecutionResultJs {
                    success: false,
                    gas_used: gas_used.to_string(),
                    output: "0x".to_string(),
                    logs: vec![],
                    created_address: None,
                }
            }
        };

        serde_json::to_string(&result_js)
            .map_err(|e| JsValue::from_str(&format!("serialization error: {}", e)))
    }
}

fn convert_log(log: &Log) -> LogJs {
    LogJs {
        address: format!("0x{:x}", log.address),
        topics: log.data.topics().iter().map(|t| format!("0x{:x}", t)).collect(),
        data: format!("0x{}", hex::encode(log.data.data.as_ref())),
    }
}
