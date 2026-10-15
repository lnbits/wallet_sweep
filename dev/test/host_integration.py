"""Instantiate the built component against real LNbits host bindings and SQLite.

Wallet backend calls are mocked. This script never uses a live wallet or relay.
"""

import asyncio
import json
import os
import shutil
import zipfile
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[2]
TEMP = tempfile.TemporaryDirectory(prefix="wallet-sweep-host-")
os.environ["LNBITS_DATA_FOLDER"] = TEMP.name
os.environ["LNBITS_BACKEND_WALLET_CLASS"] = "FakeWallet"
os.environ["LNBITS_WASM_EXTENSIONS_PATH"] = str(ROOT.parent)

from wasmtime import Store, WasiConfig, component
from lnbits.core.wasm_ext.api.host import ExtensionHostAPI
from lnurl import LnurlPayResponse
from lnbits.core.wasm_ext.api.registry import extension_api_permission_ids
from lnbits.core.wasm_ext.api.runtime import ExtensionAPIHost
from lnbits.core.wasm_ext.storage.crud import _run_storage_migration
from lnbits.core.wasm_ext.wasm.component import _wasm_engine
from lnbits.core.wasm_ext.wasm.host import add_extension_host_imports
from lnbits.core.wasm_ext.wasm.loader import load_wasm_extension
from lnbits.db import Database
from lnbits.settings import settings
from lnbits.core.models.extensions import InstallableExtension


async def main():
    extension = load_wasm_extension("wallet_sweep")
    requested = {p.id for p in extension.config.permissions}
    assert requested <= extension_api_permission_ids()
    async with Database("ext_wallet_sweep").connect() as conn:
        await _run_storage_migration(
            conn, ROOT / "storage/migrations/0001_initial.json"
        )
        await _run_storage_migration(
            conn, ROOT / "storage/migrations/0001_initial.json"
        )

    balances = {"source": 100_500, "destination": 1_000_000, "foreign": 5_000_000}
    invoices = {}
    calls = []

    async def get_wallet(wallet_id):
        amount = balances[wallet_id]
        return SimpleNamespace(
            id=wallet_id,
            user="bob" if wallet_id == "foreign" else "alice",
            name=wallet_id.title(),
            currency=None,
            balance_msat=amount,
            balance=amount // 1000,
            withdrawable_balance=max(0, amount - 2000),
            can_send_payments=True,
        )

    async def get_wallets(user_id):
        return [
            await get_wallet(key)
            for key in balances
            if (key == "foreign") == (user_id == "bob")
        ]

    async def create_invoice(wallet_id, data):
        key = f"invoice_{len(invoices)}"
        invoices[key] = (wallet_id, int(data.amount) * 1000)
        return SimpleNamespace(
            payment_hash=key.ljust(64, "a"),
            payment_request=key,
            bolt11=key,
            checking_id=key,
        )

    async def pay_invoice(**kwargs):
        calls.append(kwargs)
        destination, amount = invoices[kwargs["payment_request"]]
        balances[kwargs["wallet_id"]] -= amount
        if destination:
            balances[destination] += amount
        return SimpleNamespace(
            checking_id="checking",
            payment_hash="b" * 64,
            status="success",
            amount=-amount,
            fee=0,
            pending=False,
            success=True,
        )

    async def resolve(*_args, **_kwargs):
        return LnurlPayResponse(
            callback="https://example.com/callback",
            metadata='[ ["text/plain", "Test receiver"] ]',
            minSendable=1000,
            maxSendable=10_000_000,
        )

    async def fetch_lnurl(*_args, **kwargs):
        data = kwargs["data"]
        key = f"external_{len(invoices)}"
        invoices[key] = (None, int(data.amount))
        return SimpleNamespace(), SimpleNamespace(pr=key, successAction=None)

    loop = asyncio.get_running_loop()
    engine = _wasm_engine("wallet_sweep", 1024 * 1024)
    compiled = component.Component.from_file(engine, str(extension.module_path))

    def invoke_sync(export, payload, user, permissions):
        api = ExtensionHostAPI("wallet_sweep", permissions, user_id=user)
        store = Store(engine)
        store.set_fuel(100_000_000)
        store.set_epoch_deadline(1_000_000_000)
        store.set_limits(
            memory_size=64 * 1024 * 1024,
            table_elements=10_000,
            instances=8,
            tables=10,
            memories=1,
        )
        store.set_wasi(WasiConfig())
        linker = component.Linker(engine)
        linker.add_wasip2()
        add_extension_host_imports(linker, ExtensionAPIHost(api), loop)
        instance = linker.instantiate(store, compiled)
        function = instance.get_func(store, export)
        result = function(store, json.dumps(payload))
        function.post_return(store)
        return json.loads(result)

    async def invoke(export, payload=None, user="alice", permissions=None):
        return await asyncio.to_thread(
            invoke_sync,
            export,
            payload or {},
            user,
            list(requested) if permissions is None else permissions,
        )

    with patch("lnbits.core.crud.wallets.get_wallet", get_wallet), patch(
        "lnbits.core.crud.wallets.get_wallets", get_wallets
    ), patch(
        "lnbits.core.services.payments.create_payment_request", create_invoice
    ), patch(
        "lnbits.core.services.payments.pay_invoice", pay_invoice
    ), patch(
        "lnbits.core.services.lnurl.fetch_lnurl_pay_request", fetch_lnurl
    ), patch(
        "lnbits.core.wasm_ext.api.utils.lnurl_handle", resolve
    ):
        listed = await invoke("get-wallets")
        assert listed["ok"] and len(listed["data"]["wallets"]) == 2, listed
        quote = await invoke(
            "create-quote",
            {"sourceId": "source", "destinationId": "destination", "leaveSat": 10},
        )
        assert quote["ok"], quote
        plan = await invoke(
            "create-plan",
            {"quoteIds": [quote["data"]["id"]], "address": "me@example.com"},
        )
        assert plan["ok"], plan
        plan_id = plan["data"]["id"]
        assert not calls
        rejected = await invoke(
            "consolidate", {"planId": plan_id, "sourceId": "source", "confirm": "true"}
        )
        assert rejected["ok"] is False and not calls
        denied = await invoke("get-plan", {"planId": plan_id}, user="bob")
        assert denied["ok"] is False
        history = await invoke("get-history", {"offset": "0"}, user="bob")
        assert history["data"]["total"] == 0
        for export, payload, options in [
            ("get-balance", {"walletId": "foreign"}, {}),
            ("get-wallets", {}, {"permissions": []}),
            ("get-wallets", {}, {"user": None}),
        ]:
            try:
                await invoke(export, payload, **options)
            except PermissionError:
                pass  # Native host denial becomes HTTP 403 in the real router.
            else:
                raise AssertionError("Expected host permission denial")
        done = await invoke(
            "consolidate", {"planId": plan_id, "sourceId": "source", "confirm": True}
        )
        assert done["ok"] and done["data"]["movedSat"] == 90, done
        await invoke(
            "consolidate", {"planId": plan_id, "sourceId": "source", "confirm": True}
        )
        assert len(calls) == 1
        prepared = await invoke("prepare-payout", {"planId": plan_id})
        assert prepared["ok"], prepared
        assert prepared["data"]["payout"]["amountSat"] == 88
        assert len(calls) == 1
        request = {
            "planId": plan_id,
            "payoutId": prepared["data"]["payout"]["id"],
            "address": "me@example.com",
            "confirm": True,
        }
        sent = await invoke("send-payout", request)
        assert sent["ok"] and sent["data"]["payout"]["status"] == "success", sent
        await invoke("send-payout", request)
        assert len(calls) == 2
        assert balances["source"] == 10_500
        assert balances["destination"] == 1_002_000
    artifact = ROOT / "dist/wallet_sweep-0.1.0.zip"
    if artifact.exists():
        metadata = InstallableExtension.from_wasm_ext_dir("wallet_sweep")
        assert metadata
        shutil.copyfile(artifact, metadata.zip_path)
        config = metadata.load_archive_config()
        metadata.validate_archive(config)
        with zipfile.ZipFile(artifact) as archive:
            assert all(name.startswith("wallet_sweep/") for name in archive.namelist())
            assert not any("/dev/" in name for name in archive.namelist())
        settings.lnbits_wasm_extensions_path = str(Path(TEMP.name, "installed_wasm"))
        metadata.extract_wasm_archive()
        installed = load_wasm_extension("wallet_sweep")
        assert installed.module_path.read_bytes() == extension.module_path.read_bytes()
        print(
            "PASS: release ZIP accepted and extracted by the real LNbits WASM installer."
        )
    print(
        "PASS: real WIT imports, default runtime limits, SQLite migrations, owner isolation, denied permissions, both payment phases, and replay protection (mock backend)."
    )


try:
    asyncio.run(main())
finally:
    TEMP.cleanup()
