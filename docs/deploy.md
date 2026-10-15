# 社内向け無料版の公開手順

Agent Guild の無料版（報奨金・支払なし）を、社内メンバーだけが使えるように無料の VM で公開する手順です。#10 の判断（社内限定・自己責任、2026-10-14）に基づきます。USDC 報奨金は #9 で保留中のため無効です。

## 構成

```
社内ネットワーク ──HTTPS──▶ [クラウドのファイアウォール: 443 は社内 IP だけ]
                            ▶ Caddy（自動証明書、remote_ip で社内 IP 以外は 403）
                            ▶ Node サーバー 127.0.0.1:46077（GitHub 組織メンバーのログイン必須）
                            ▶ /opt/agent-guild/data/listings.sqlite（毎日 4:00 に停止時バックアップ）
```

アクセス制御は3段です。

1. **ファイアウォール**: 443 番は社内 IP からだけ受け付ける。
2. **Caddy**: 社内 IP 以外には 403 を返す。
3. **アプリ**: 閲覧も含めて全ページで GitHub ログインを必須にし、`AGENT_GUILD_GITHUB_ORG` の有効なメンバー以外は 403 にする。組織が SAML SSO を使う場合、初回ログインで SSO の認可を求められる。

## 無料で使えるホスティング

SQLite をディスクに残す必要があるため、永続ディスクのない無料枠（Render の無料 Web Service、Cloud Run など）は使いません。再起動のたびにデータが消えるためです。

| 候補 | 費用 | 向き・注意 |
| --- | --- | --- |
| **Oracle Cloud Always Free（推奨）** | 無料 | 東京リージョンを選べる。AMD の VM.Standard.E2.1.Micro（1 GB）で動く。ビルド時のメモリ不足に備えて、`setup.sh` が swap を作る。登録にクレジットカードが必要。Ubuntu イメージは OS の iptables でも 80/443 を閉じているので、下の手順で開ける。 |
| GCP Always Free e2-micro | 無料 | 米国の対象リージョン（us-west1 など）に限られる。日本からは遅延が少し増える。標準永続ディスク 30 GB まで無料。 |
| 社内の常時稼働 PC・サーバー | 無料 | 同じ手順で動く。社内 LAN だけで使う場合、HTTPS 証明書の取得方法は別途決める。 |

アカウント作成、VM 作成、GitHub OAuth App の発行は、利用者本人が行ってください。

## 手順

### 1. VM とネットワーク

- Ubuntu 22.04 または 24.04 の VM を作る。
- ファイアウォール（Oracle は VCN のセキュリティリスト、GCP は VPC ファイアウォール）を次のように設定する。
  - **22**: 自分の IP だけ許可する。
  - **443**: 社内の接続元 IP だけ許可する。
  - **80**: 全体に許可する。Let's Encrypt の証明書発行に使う。Caddy は 80 番では HTTPS への転送と証明書の確認応答だけを返す。
- Oracle の Ubuntu イメージは、OS 内の iptables でも 80/443 を開ける必要がある。

  ```bash
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
  ```

### 2. ドメイン

- 社内ドメインのサブドメイン（例: `agent-guild.example.co.jp`）の A レコードを、VM のパブリック IP に向ける。
- 社内ドメインを使えない場合は、IP を埋め込んだ無料のホスト名 `<IPのドットをハイフンにしたもの>.sslip.io` も使える（例: `203-0-113-10.sslip.io`）。

### 3. GitHub OAuth App

- 組織の **Settings → Developer settings → OAuth Apps → New OAuth App** で作成する。
  - Homepage URL: `https://<ドメイン>`
  - Authorization callback URL: `https://<ドメイン>/api/auth/callback`
- Client ID と、生成した Client secret を控える。secret はリポジトリ、チャット、Issue に書かない。
- 組織で OAuth App のアクセス制限（Third-party application access policy）を有効にしている場合は、組織オーナーがこの App を承認する。
- アプリはログイン時に `read:org` を要求し、組織メンバーかどうかを確認する。

### 4. サーバーの設定と起動

```bash
sudo git clone https://github.com/maasa1221/agent-guild.git /opt/agent-guild
sudo install -d -m 700 /etc/agent-guild
sudo cp /opt/agent-guild/deploy/app.env.example /etc/agent-guild/app.env
sudo cp /opt/agent-guild/deploy/caddy.env.example /etc/agent-guild/caddy.env
sudo nano /etc/agent-guild/app.env     # ORIGIN、Client ID/secret、組織名、管理者 ID
sudo nano /etc/agent-guild/caddy.env   # ドメイン、社内 IP（CIDR、空白区切り）
sudo bash /opt/agent-guild/deploy/setup.sh
```

本番の `data/` は空の状態から始めてください。ローカルデモの DB を持ち込むと、報奨金付きの掲載は無料版では検収・取消できません。

`setup.sh` は、設定値が例のまま・空でないことを確認してから、次を行います。

- メモリが 2 GB 未満で swap がなければ、ビルド用に 2 GB の swap を作る。
- Node.js 22 と Caddy を入れる。
- 専用ユーザー `agentguild` を作る。
- `npm ci` とビルドを行う。
- systemd サービス、日次バックアップのタイマー、Caddy の設定を配置して起動する。

管理者 ID は GitHub の数値 ID です。ブラウザで `https://api.github.com/users/<ログイン名>` を開くと確認できます。

### 5. 確認

- 社外の回線（携帯回線など）から開くと 403 になること。
- 社内から開くと GitHub ログインに進み、組織メンバーなら一覧が表示されること。
- 組織外のアカウントでログインすると 403 になること。
- 掲載画面に報奨金の入力欄がなく、上部に「無料版」と表示されること。

## 運用

- **更新**: 次のコマンドで更新する。セッションはメモリ上にあるため、再起動すると全員ログアウトする。

  ```bash
  cd /opt/agent-guild && sudo git pull && sudo bash deploy/setup.sh
  ```

- **ログ**: `journalctl -u agent-guild -u caddy`
- **バックアップ**:
  - 毎日 4:00（VM のタイムゾーン）に数秒サービスを止め、`data/` を `/var/backups/agent-guild/<日時>` にコピーする。直近 14 世代を残す。セッションはメモリ上にあるので、このとき全員ログアウトされる。意図して停止中のサービスは、バックアップ後も起動しない。
  - 手動で取るときは `sudo systemctl start agent-guild-backup` を実行する。
  - バックアップは同じ VM のディスク上にあるので、VM ごと失うと戻せない。重要になったら別の保管先へのコピーを足す。
- **復元**: [復旧手順案](offline-recovery.md) のとおり、サービスを止め、バックアップを隔離先で確認してから `data/` を差し替える。
- **保存データ**: 何が保存されているかは [運用準備メモの保存データの棚卸し](decision-readiness.md) と `server/data-inventory.mjs` を参照する。
- **停止**: `sudo systemctl stop agent-guild caddy` で全停止する。特定の掲載だけ止めたいときは、管理者が hide する。

組織メンバーかどうかはログイン時にだけ確認します。組織から外れた人も、既存のセッションは最長 8 時間（または次の再起動・毎朝のバックアップ）まで有効です。すぐに止めたいときは `sudo systemctl restart agent-guild` で全セッションを失効させてください。

## 範囲外

- USDC 報奨金と実送金（#9 で保留）。
- 社外への公開。
- 冗長構成。
- 監視・通知の自動化。
