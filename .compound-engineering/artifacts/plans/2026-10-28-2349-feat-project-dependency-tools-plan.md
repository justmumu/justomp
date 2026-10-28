---
title: "justomp Project Selection and Dependency Tools - Plan"
type: feat
date: 2026-10-28
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# justomp Project Selection and Dependency Tools - Plan

## Goal Capsule

- **Objective:** OMP agentı, tek projeli veya çok projeli bir klasörde doğru projenin bağımlılıklarını listeleyebilsin, ekleyebilsin, kaldırabilsin, güncelleyebilsin ve mevcut bağımlılık ortamını kurabilsin.
- **Means:** Ayrı custom tool'lar, ortak dependency servisi ve paket yöneticisi adaptörleri (KTD2).
- **Target:** Mevcut justomp extension'ı. Başlangıç referansı ca21942; yalnız inspection özelliği mevcut.
- **Authority:** Kullanıcının bu plandaki R-ID'lerde korunan kararları → Planning Contract → uygulama ayrıntıları. Önceki inspection planı yalnız mevcut davranışın kaynağıdır.
- **Boundary:** Bu belge uygulama yetkisi vermez. Kullanıcı planı inceleyip uygulamayı ayrıca başlatır. Commit, push, PR, release veya gerçek kullanıcı projelerinde bağımlılık değişikliği bu planlama çalışmasının parçası değildir.
- **Stop conditions:** Yerel/native davranış bir R-ID'yi karşılamıyorsa bunu sessizce başka davranışla değiştirme. Paket yöneticisi veya sürüm eksikse kurma; açık hata üret. Doğrulanmamış adaptörü destekleniyor diye sunma.

---

## Product Contract

### Summary

Mevcut inspection sonucuna kararlı project_id eklenir. Parametresiz list_projects, agent'ın hedef seçmesini sağlar. dependency_list, dependency_add, dependency_remove, dependency_update ve dependency_sync aynı hedef çözümleme ve çalıştırma servisini kullanır.

İlk sürüm uv, pnpm, npm, Yarn ve Bun ile Go modüllerini kapsar. Paket yöneticileri proje dosyalarını ve ortamı kendi native işlemleriyle günceller. Tool sonucu istenen işlemi, gerçek etkileri ve başarısızlıkları agent'a yapılandırılmış olarak bildirir.

### Problem Frame

Yalnız klasör yolu, aynı klasörde birden fazla ekosistem varsa hedefi ayıramaz. Agent'ın ekosistemi veya paket yöneticisini tekrar belirtmesi inspection ile çelişen bilgi üretebilir. Çok projeli yapılarda seçilen projenin manifesti ile ortak lock dosyasının sahibi de farklı olabilir.

Paket yöneticilerinin grup, workspace ve güncelleme davranışları eşit değildir. Sadece komut adlarını ortak isimlerle sarmalamak, yanlış grubu kaldırmaya veya kardeş projelerin tanımlarını değiştirmeye neden olabilir.

### Requirements

#### Proje kimliği ve seçim

- R1. Her proje, ekosistem ve root'a göre normalize edilmiş manifest yolundan deterministik project_id alır. Aynı konumda yeniden inspection, paket adı/sürüm değişikliği veya root'un başka bilgisayara kopyalanması kimliği değiştirmez; manifestin root içindeki yolu değişirse kimlik değişir.
- R2. project_id, .justomp/packaging_structure.json içindeki proje kaydına yazılır. Workspace üyeliği ve yerel bağımlılık referansları aynı kimliği kullanır.
- R3. list_projects input almaz. Oturum root'u için getPackagingStructure() kullanır ve yalnız projects içindeki project_id/relative_path çiftlerini döndürür; root proje yolu nokta karakteridir.
- R4. Bütün dependency tool'ları hedefi project_id ile alır. Agent'tan ecosystem, manager, çalışma dizini veya serbest shell komutu istenmez; hedef güncel getter sonucundan çözülür.

#### Tool kapsamı ve bağımlılık seçimi

- R5. İlk teslimde uv, pnpm, npm, Yarn Classic ve modern Yarn, Bun ve Go adaptörleri bulunur. Desteğin sürüm ve capability sınırları açıkça belirtilir; desteklenmeyen kombinasyon mutasyondan önce hata verir.
- R6. dependency_list varsayılan olarak doğrudan tanımlı bağımlılıkları gösterir. include_transitive: true dolaylı bağımlılıkları da ister; eksik graph veya çözüm bilgisi boş/başarılı tam liste gibi sunulmaz.
- R7. dependency_add ve dependency_remove için grup zorunludur. Eksik veya native karşılığı olmayan grup reddedilir; aynı adın başka gruptaki tanımı sessizce taşınmaz veya kaldırılmaz.
- R8. Registry, Git, yerel klasör ve workspace kaynakları ilk sürüm kapsamındadır. Adaptör native kaynak anlamını korur; desteklenmeyen kaynak/grup/işlem kombinasyonunda registry kaynağına düşmez.
- R9. dependency_update, boş olmayan açık packages listesi gerektirir. all parametresi, wildcard veya paket belirtilmediğinde tümünü güncelleme davranışı yoktur.
- R10. Update isteğinde version verilmiş paket belirtilen sürüme geçirilir; downgrade geçerlidir. Version içermeyen isteklerde mode, within_constraints veya latest olabilir; belirtilmezse within_constraints uygulanır. İstekte herhangi bir version ile açık mode birlikte kullanılamaz.
- R11. within_constraints mevcut tanımlardaki koşulları karşılayan çözümü seçer. latest hedef tanımın sürüm kısıtını native yolla değiştirebilir; diğer bağımlılık/runtime koşullarını veya kaynak türünü ortadan kaldırmaz.
- R12. Mutasyon sonrası manifest, native lock/bütünlük metadata'sı ve seçilen ortam paket yöneticisi tarafından birlikte ele alınır. Extension kendi dependency solver'ını veya doğrudan manifest/lock düzenleyicisini yazmaz.
- R13. dependency_sync mevcut seçilmiş bağımlılıkları, bilinçli sürüm yükseltmesi yapmadan native ortamına getirir. Gerçek lock kullanan yöneticilerde eksik veya uyumsuz lock hata verir; Go'nun checksum dosyası lock olarak sunulmaz.

#### Yan etkiler, süreçler ve sonuç

- R14. Native komut başarısızlığında extension ek otomatik rollback yapmaz. Native aracın kendi geri alma davranışı korunur; oluşmuş değişiklikler ve tamamlanmış aşamalar bildirilir.
- R15. Aynı ortak yazma alanını etkileyen extension işlemleri süreç içi sırada çalışır; bağımsız alanlar paralel çalışabilir. Kalıcı busy kaydı, disk kilidi veya daemon eklenmez.
- R16. İptal isteği, çalışan komut gerçekten sonlanmadan sırayı serbest bırakmaz. Sırada bekleyen isteğin iptali çalışan başka isteği iptal etmez.
- R17. Paket yöneticisi veya gerekli sürüm kurulu değilse tool açıklayıcı hata döndürür. Otomatik manager kurulumu, başka manager'a geçiş veya global ayar değişikliği yapılmaz.
- R18. Tool, native çözücünün dolaylı bağımlılık etkilerini raporlar. Modern Yarn'ın seçilen paket adlarını ortak lock genelinde yeniden çözmesine izin verilir; kardeş workspace'lerin çözülen sürümleri değişebilir, manifest kuralları korunur ve etkilenen projeler bildirilir.
- R19. Sonuçlar modelin okuyabildiği content içinde bulunur; yalnız OMP details alanında tutulmaz. Başarı, komut hatası, iptal, kısmi işlem ve başarılı mutasyon sonrası inspection hatası birbirinden ayırt edilir.
- R20. Mevcut inspection sözleşmesi korunur: root açık ve sabittir, config alan bazında tamamlanır, varsayılan dışlamalar korunur, getter disk JSON'unu cache girdisi yapmaz. Mutasyon çıktısı anlık/atomik tüm-filesystem snapshot garantisi değildir.

### Key Decisions

- **Inspection üzerinden hedef seçimi.** Agent'ın ayrıca ekosistem göndermesi yerine R1–R4 uygulanır. (session-settled: user-directed — chosen over agent-supplied ecosystem: hedef bilgisi inspection'da zaten var.)
- **İlk sürüm bütün yöneticileri kapsar.** Governs R5. (session-settled: user-directed — chosen over uv/pnpm/Go ile sınırlı ilk sürüm: diğer yöneticiler ertelenmeyecek.)
- **Gruplar açık seçilir.** Governs R7. (session-settled: user-directed — chosen over varsayılan runtime grubu: agent'ın eksik parametreyle yanlış hedef seçmesi önlenir.)
- **Açık paket listesi kullanılır.** Governs R9. (session-settled: user-directed — chosen over all seçeneği: agent tüm paketleri dependency_list'ten alabilir.)
- **Native yönetim ve kısmi hata raporu.** Governs R12–R14. (session-settled: user-approved — chosen over elle dosya yönetimi ve ek rollback: manager kendi işlemlerini yürütür.)
- **Bellekte eşzamanlılık kontrolü.** Governs R15–R16. (session-settled: user-approved — chosen over eşzamanlı ortak-lock yazıları veya kalıcı busy state: ortak alan korunur, kalıcı takılı kayıt oluşmaz.)
- **Ortak Yarn çözümleme etkisi görünürdür.** Governs R18. (session-settled: user-approved — chosen over kardeş resolution değişebilecek her isteği reddetmek: native ortak-lock davranışı korunur ve etkiler raporlanır.)

### Acceptance Examples

- AE1. apps/api/pyproject.toml yeniden tarandığında aynı kimlik döner; apps/backend altına taşındığında eski kimlikle mutasyon project-not-found olur. Covers R1–R4.
- AE2. Aynı klasörde package.json ve pyproject.toml varsa list_projects iki farklı kimlik ve aynı relative_path döndürür. Kimlik ekosistem önekinden ayırt edilebilir. Covers R1, R3.
- AE3. Grupsuz add/remove veya boş packages içeren update, hiçbir child process çalıştırmadan reddedilir. Covers R7, R9.
- AE4. Mevcut koşulu >=1,<2 olan registry paketi normal update ile 2'ye geçmez; latest geçebilir; version: 1.4.0 hedefli downgrade izinlidir. Mode ile version birlikte verilirse hata döner. Covers R10–R11.
- AE5. Workspace kaynağıyla ekleme yerel üyeyi bulamazsa registry paketini kurmaz. Covers R8.
- AE6. Aynı lock'u paylaşan iki istek sırayla çalışır; birincisi iptal edildiğinde process kapanmadan ikinci başlamaz. Covers R15–R16.
- AE7. Manifest değiştiren ilk native aşama başarılı, kurulum aşaması başarısızsa sonuç partial_change bildirir; başlangıç dosyaları geri yazılmaz. Covers R12, R14, R19.
- AE8. Yarn workspace A'da foo için within_constraints çalışırken B'deki foo çözümü de değişirse sonuç B'yi içerir; A/B manifest kuralları değişmez. Covers R18.
- AE9. Manager shim'i gerekli sürümü indirmek istiyorsa işlem manager-unavailable döner; aracı kurmaz veya proje manager tanımını değiştirmez. Covers R17.

### Scope Boundaries

Mevcut inspection'a kimlik/workspace genişletmesi, altı tool, dependency servisi, manager adaptörleri, gerçek manager fixture'ları ve kullanım dokümanları dahildir.

Bu iş kapsamında project scaffolding, template/Copier aktarımı, project_check, release/Git araçları, dosya koruma hook'ları, manager geçişi, runtime/toolchain yükseltmesi veya kaynak kod/import migration'ı yapılmaz. Go modül yolunu /v2'ye taşıma bir dependency_update değildir.

R14–R16 gereği otomatik rollback, disk kilidi, stale-reservation onarımı, daemon, otomatik retry ve background job/resume protokolü kurulmaz. Harici terminal veya başka OMP süreciyle OS düzeyinde izolasyon sağlanmaz; bu süreç içi tool koordinasyonudur.

Yerel/workspace kaynakları bu sürümde inspection root'u içinde çözülür. Dış path, symlink ile kaçış veya dış workspace sahibi gerekiyorsa daha geniş ve bilinçli seçilmiş root istenir. Native manager'ın kendi workspace genişlemesi bu sınırı aşamaz.

### Success Criteria

Her desteklenen manager varyantında gerçek fixture ile list/add/remove/update/sync doğrulanır. Grup ve kaynak korunur; belirtilmemiş manifest tanımları değişmez. Go sync sırasında native aracın gerekli gördüğü go.mod değişiklikleri, aşağıdaki Go sözleşmesine uygun olarak raporlanır; bilinçli upgrade, otomatik tidy veya go work sync yapılmaz. Native solver etkileri R18 kapsamında görünürdür. Mevcut inspection regresyonları geçmeye devam eder; üretim/kullanıcı projelerinde test mutasyonu yapılmaz.

---

## Planning Contract

### Existing Code and Prerequisites

- src/inspect/readers/manifest.ts merkezi olarak id = relativeDirectory:ecosystem üretir. Yeni kimlik alanı henüz yoktur.
- src/inspect/model.ts, relationships.ts ve scan.ts, id referanslarını kullanır; snapshot schemaVersion 1'dir. U1 bütün üretici/tüketicileri birlikte günceller.
- package.json workspaces şu anda unsupported sayılır. Yalnız uv/pnpm/Go üyelikleri çözümlenir; npm/Yarn/Bun için U1 ön koşuldur.
- Inspection lock içeriklerini dependency inventory olarak okumaz. Python grup bilgisi mevcut keşif okuyucusunda düzleştirilir; dependency_list için ayrı grup koruyan okuyucular gerekir.
- src/packaging/get-structure.ts, OMP'nin modülleri tekrar yüklemesi nedeniyle Symbol.for ile süreç genelinde registry kullanır. Queue da aynı paylaşım yaklaşımını izler.
- OMP 18.13.3'te tool approval değerleri read/write/exec'tir. Custom tool execute gövdesinde genel 30 saniyelik limit yoktur; session_shutdown handler limiti 2 saniyedir. Mevcut 24 saniyelik inspection bütçesi paket işlemlerine taşınmaz.
- pi.exec, env veya streaming/output sınırı parametresi sunmaz. Dolaylı pi-utils bağımlılığı Bun >=1.4.4 isterken repo 1.4.2 kullanır; bu plana gizli bir runtime yükseltmesi eklenmez.

### Key Technical Decisions

- KTD1. Tek kimlik üreticisi, project_id değerini ekosistem öneki ve normalize POSIX relative manifest yolundan üretir; örnek python:apps/api/pyproject.toml. project_id bir lookup anahtarıdır, işlem yolu olarak parse edilmez. Project.id yerine project_id geçer; workspace/edge referansları aynı commit biriminde güncellenir ve snapshot schemaVersion 2 olur. Disk snapshot cache girdisi olmadığından eski JSON ilk başarılı keşifte yenilenir; bu pre-release API değişikliği belgelenir. Implements R1–R4. (session-settled: user-approved — chosen over kalıcı taşıma kaydı: klasör taşınırsa kimlik değişebilir.)
- KTD2. OMP tool katmanı yalnız şema/lifecycle/result çevirisini yapar. Ortak servis hedef, queue, native süreç ve metadata farkını yönetir; adaptörler capability, inventory ve native işlem planını sağlar. Implements R4–R19. (session-settled: user-approved — chosen over her tool içinde yinelenen manager mantığı: ortak yürütme ve ayrı adaptörler kullanılacak.)
- KTD3. Manager seçimi mevcut metadata, lock ve workspace kanıtına dayanır. Çelişkili/bilinmeyen manager otomatik seçilmez. Gerekli manager sürümü ayrıca saklanır; Yarn Classic/modern ayrı capability varyantlarıdır. Gizli manager config'leri işlem başında doğrudan okunur; inspection dışlamaları gevşetilmez. Implements R5, R17, R20.
- KTD4. Paket grubu native declaration konumudur. Paket adı tek başına birden fazla tanımı işaret ediyorsa update isteği optional group ile ayırt edilir; tek grupta birden fazla marker/source tanımı varsa işlem ambiguous-dependency döner. Kapsamı koruyamayan native işlem çalıştırılmaz. Implements R7, R10–R11.
- KTD5. within_constraints seçilen sürümün başlangıç kısıtlarını karşılamasıdır; native manager'ın alt sınırı kendi standart biçiminde yeniden yazması byte eşitliği ihlali sayılmaz. Exact registry sürümü native exact pin olarak kaydedilir; Go require kaydı minimum sürüm olduğundan sonuçtaki selected version ayrıca doğrulanır. Git ref veya local source registry sürümüne çevrilmez. Implements R8–R12.
- KTD6. Queue, canonical workspace/lock sahibi ve paylaşılan ortamın gerçek yazma alanına göre anahtarlanır. Birden fazla alan varsa deterministik sıra ile alınır. Kuyruk edinildikten sonra getter, hedef manifesti ve gerekli manager config'leri yeniden okunur; alan değişmişse eski lease bırakılıp yeni plana göre tekrar sıraya girilir. Implements R15–R16, R20.
- KTD7. node:child_process tabanlı dar bir argv runner kullanılır; shell birleştirme yoktur. Runner per-call env, bounded stdout/stderr, process exit ve iptal sinyallerini yönetir. POSIX process grubu ve Windows process-tree sonlandırma davranışları ayrı test edilir; daemonize olup supervision'dan kaçan süreçler için sandbox garantisi verilmez. Implements R14–R17, R19.
- KTD8. Mutasyondan önce yalnız planlanan manifest/lock/workspace-config dosyaları bellekte fingerprint edilir; sonra aynı dosyaların farkı alınır. Git diff'e bağımlılık yoktur. Sonuç, dependency metadata değişikliklerini bildirir; node_modules/.venv içindeki her dosyanın envanteri tutulmaz. Implements R14, R18–R19.
- KTD9. Manager işlemi bittikten sonra inspection force-refresh edilir. Refresh başarısızsa manager'ın gerçekleşmiş başarısı saklanır ve structure_refresh_error ayrıca döner; işlem geri alınmış gibi sunulmaz. Implements R19–R20.
- KTD10. Mutating dependency tool'ları exec onay sınıfındadır. list_projects getter'ın JSON yayını nedeniyle write sınıfındadır; dependency_list native metadata komutu çalıştırabiliyorsa exec sınıfı kullanır. Paket lifecycle/build script'leri manager'ın mevcut native politikalarına tabidir; extension trust ayarlarını yükseltmez. Implements R12, R19.

### Tool Interface

Aşağıdaki JSON biçimleri hedef API sözleşmesidir. Bütün object şemaları bilinmeyen alanları reddeder; manager/path/command gibi alternatif hedef parametreleri kabul edilmez.

**list_projects** input nesnesi boştur; response biçimi:

    {"projects":[{"project_id":"python:apps/api/pyproject.toml","relative_path":"apps/api"}]}

**dependency_list**:

    {"project_id":"…","include_transitive":false}

Yanıt dependency kayıtlarını, manager/version bilgisini, supported_groups ve operation capability'lerini içerir. Bir kayıt name, group, source, declared_specifier, direct, mevcutsa resolutions ve evidence taşır. Kilitte birden fazla platform/marker çözümü varsa tek sürüme indirilmez. installed_version ancak gerçekten ölçülmüşse eklenir. complete ve diagnostics eksik graph bilgisini görünür kılar.

**dependency_add**:

    {"project_id":"…","group":{"kind":"dev"},"packages":[{"name":"httpx","version":">=0.28","source":{"kind":"registry"}}]}

Add sürüm alanı native sürüm koşulu kabul eder; update'teki exact version alanıyla aynı anlamda değildir. Her add kaydında source açık bir tagged object'tir. registry için version opsiyoneldir; git için URL/module identity ve ref, path için root-relative path, workspace için target_project_id kullanılır. Geçersiz alan kombinasyonları reddedilir.

**dependency_remove**:

    {"project_id":"…","group":{"kind":"dev"},"packages":[{"name":"httpx"}]}

**dependency_update**:

    {"project_id":"…","packages":[{"name":"httpx"}],"mode":"within_constraints"}

veya

    {"project_id":"…","packages":[{"name":"httpx","version":"0.28.1","group":{"kind":"dev"}}]}

Update'te version tek bir native release sürümüdür; range, wildcard ve latest etiketi version yerine geçmez. Version ve açık mode çatışması request düzeyindedir. Açık mode yokken karışık listede version içeren öğeler exact, diğerleri within_constraints olur. Aynı dependency occurrence için yinelenen/çelişen hedefler reddedilir.

**dependency_sync**:

    {"project_id":"…"}

Sync native proje/manager default grup seçimini korur; bütün optional grupları aynı anda kurmaya zorlamaz. İlgili ekosistemde ortam kavramı yoksa cache/materialization sonucu açıkça ifade edilir.

**Group selector:** runtime, dev, optional, peer, named veya extra. named/extra için name zorunlu, diğerlerinde name yasaktır. Her adaptör desteklediği alt kümeyi bildirir. Go'da normal bağımlılıklar için runtime açıkça verilmelidir; indirect bir install grubu değildir.

### Native Capability Matrix

Bu tablo komutların anlamını sabitler; argv/flag ayrıntıları manager sürümüne göre adaptörde doğrulanır.

| Manager | Grup modeli | Within / latest / exact | Sync ve scope |
|---|---|---|---|
| uv | runtime, dev, named, extra | Seçili upgrade-package ile sınır içi; latest/exact için özgün grup/marker/source korunarak native declaration güncellemesi | Tutarlı mevcut uv.lock ile locked sync; workspace ortak lock ve seçili grup ortamı |
| npm | runtime, dev, optional, peer | update hedefleri / install latest / exact install | ci, mevcut uyumlu lock; node_modules yeniden kurulabilir |
| pnpm | runtime, dev, optional, peer capability | update hedefleri / latest / version selector | frozen-lockfile install; workspace ortak kurulum alanı |
| Yarn Classic | runtime, dev, optional, peer | workspace kapsamlı upgrade / latest / version selector | frozen-lockfile install; ortak yarn.lock |
| Yarn modern | runtime, dev, optional, peer | up -R ile seçili adlar ortak lock'ta sınır içi; latest/exact için workspace-local add | immutable install; R18 ortak resolution etkisi |
| Bun | runtime, dev, optional, peer | update hedefleri / latest / version selector | frozen-lockfile install; ortak bun.lock/bun.lockb |
| Go | runtime; require/indirect ayrımı | Aynı module path için upgrade / latest / exact query | Seçili graph materialization; go.sum bütünlük kaydıdır, frozen lock değildir |

Yarn modern normal up komutu kardeş manifestleri değiştirebildiğinden hedefli update'e doğrudan bağlanmaz. Recursive resolution yaklaşımı R18 kapsamında bütün aynı-ad descriptor'larını etkileyebilir. npm/Bun'da grup seçerek silme, native pkg delete ve ardından native install aşamalarını gerektirebilir. Yarn'da aynı paket birden fazla gruptaysa grup güvenli remove native karşılığı bulunamadığında mutasyondan önce unsupported-group-operation döner. pnpm peer eklemesinin native dev eşliği ve Bun'un gruplar arası taşıma davranışı capability kontrolünde ele alınır; beklenmedik grup taşıması kabul edilmez.

Git/path/workspace güncellemesi yalnız mevcut source seçicisinin native anlamı içinde yapılır. Bir branch'in commit'ini yenilemek ile registry latest aynı şey değildir. Immutable Git pinini değiştirmenin veya local proje sürümünü yükseltmenin karşılığı yoksa unsupported-source-operation döner; kaynak değiştirmek için açık add isteği kullanılır.

Go Git kaynağı arbitrary URL'den module adı tahmini değildir; module identity + ref kullanılır. Yerel dependency için native require/replace işlemi gerekebilir; go.work üyeliği bağımlılık tanımının yerine geçmez. Otomatik tidy veya go work sync, add/remove/sync sonuna eklenmez; bunlar ek tanım değişiklikleri yaratabilir.

### Inventory and Source Evidence

Doğrudan inventory her zaman hedef manifestten okunur; ortamın kurulmuş olması gerekmez. Transitive inventory native lock graph'ı veya doğrulanmış read-only manager sorgusundan gelir. UV tree sorgusu frozen biçimde kullanılır; npm/pnpm lock-aware listeleme ile installed görünümü ayrılır; Yarn modern ve Classic farklı okuyucular kullanır; Bun binary/text lock sürümleri ayrı capability'dir.

Go'da go.sum graph olarak parse edilmez. go.mod içindeki indirect işaretleri ile tam çözülen graph birbirinden ayrılır. Tam graph için gereken read-only sorgu eksik cache/sum nedeniyle yazacak veya fetch gerektirecekse bu çağrıda çalıştırılmaz; complete:false ve resolution-unavailable döner. Graph hazır olduğunda include_transitive gerçek tam graph'ı döndürmelidir; bu capability yalnız mock ile tamamlanmış sayılmaz.

Manager config okuması read-only'dir. URL credential/token'ları content, stderr özetleri veya metadata farkı raporuna taşınmaz. Native credential store/env kullanılabilir; extension secret depolamaz veya auth kurulumu yapmaz.

### Process, Queue and Result Lifecycle

~~~mermaid
flowchart LR
  T[OMP tools] --> S[Dependency service]
  S --> G[getPackagingStructure]
  S --> Q[Shared write-domain queue]
  Q --> A[Versioned manager adapter]
  A --> P[Supervised native process]
  P --> D[Metadata diff and inspection refresh]
  D --> R[Model-visible structured result]
~~~

~~~mermaid
sequenceDiagram
  participant Tool
  participant Getter
  participant Queue
  participant Manager
  Tool->>Getter: Resolve project and owner
  Tool->>Queue: Wait for write domain
  Queue-->>Tool: Lease acquired
  Tool->>Getter: Revalidate project, owner and config
  Tool->>Manager: Validated argv and scoped environment
  Manager-->>Tool: Exit or cancellation completion
  Tool->>Getter: Force refresh after possible writes
  Tool->>Queue: Release after supervised completion
  Tool-->>Tool: Return outcome and affected metadata
~~~

~~~mermaid
stateDiagram-v2
  [*] --> Validating
  Validating --> Queued: supported request
  Validating --> Rejected: invalid or unsupported
  Queued --> Running: lease and revalidation
  Queued --> Cancelled: cancelled before spawn
  Running --> Stopping: cancellation or shutdown
  Stopping --> Observing: process termination confirmed
  Running --> Observing: exit
  Observing --> Finished: report and release
  Rejected --> [*]
  Cancelled --> [*]
  Finished --> [*]
~~~

~~~mermaid
flowchart TD
  I[Update request] --> V{Any explicit version?}
  V -->|Yes| M{Explicit mode also present?}
  M -->|Yes| E[Reject before spawn]
  M -->|No| X[Exact entries plus default within for others]
  V -->|No| D{Mode}
  D -->|omitted or within_constraints| W[Honor existing requirements]
  D -->|latest| L[Native selected declaration update]
  X --> C[Validate group and source capability]
  W --> C
  L --> C
~~~

Runner spawn/permission hatasını çalışan süreçten ayırır. Çıktı bounded olarak tüketilir; sessiz komut da iptal edilebilir. İptal önce nazik sonlandırma, ardından sınırlı grace içinde force termination uygular; lease yalnız supervision sonucu kesinleşince bırakılır. Shutdown handler girişinde yeni işler reddedilip abort hemen tetiklenir; OMP'nin 2 saniyelik hook bütçesi işlem bitti kanıtı olarak kullanılmaz.

Sonuç şeması outcome, requested, manager, affected_projects, metadata_changes, native_steps ve diagnostics alanlarını taşır. affected_projects için değiştiği doğrulanmış projeler ile yalnız çözümleme kapsamındaki projeler ayrılır; graph eksikse kapsam tam ölçülmüş gibi gösterilmez. metadata_changes yalnız dependency metadata'sını kapsar. stdout/stderr sınırlı ve redakte olarak eklenir; exit_code ve signal ayrı tutulur.

### Executable and Root Boundaries

Manager sürümü PATH ve native project metadata üzerinden önceden doğrulanır. Corepack ve benzeri launcher'ların otomatik indirme/auto-pin davranışı per-call ortam ile kapatılır; npx/bunx/uvx ile eksik manager edinilmez. Go toolchain auto-download ve uv Python auto-download da işlem sırasında beklenmedik araç kurulumu yapmayacak şekilde kontrol edilir. Bun/pnpm runtime yönetim ayarları varsa karşılanmayan gereksinim açıkça raporlanır.

İstek içindeki paket/spec/ref değerleri yalnız ilgili native alanlara çevrilir; flag, glob, path traversal veya arbitrary config key olarak kullanılamaz. Native pkg delete için property path'i servis üretir. Registry'de node/bun/yarn gibi manager'ın özel komut olarak yorumlayabildiği adlar açık registry formuyla ayırt edilir.

Workspace sahibi inspection root'u dışındaysa veya manager config'i yazma alanını doğrulanamayan dış konuma taşıyorsa before-spawn scope hatası verilir. GetPackagingStructure'ın watcher garantisi yerine mutasyon öncesi gerekli metadata tekrar okunur; kullanıcı terminaliyle eşzamanlı dış değişikliklere karşı tam transaction iddiası yoktur.

### Assumptions and Resolved Technical Choices

- Tek tool çağrısı tek project_id hedefler; birden fazla paket aynı çağrıda desteklenir. Farklı gruplarda toplu add/remove için ayrı çağrılar yapılır.
- Update'te group yalnız ambiguity çözmek için opsiyoneldir; add/remove zorunluluğu R7'de kalır.
- Kaynak kodu değiştirmek ve toolchain yönetmek normal dependency işlemi değildir.
- Her tarihî manager sürümünü destekleme sözü verilmez. Release manifestinde exact test edilmiş sürümler ve desteklenen ana sürüm varyantları bulunur; bilinmeyen capability güvenli hata verir.
- Go sync, native checksum metadata'sını değiştirebilir; bilinçli upgrade işlemi değildir. Native araç gerekli go.mod değişikliğini yaparsa sonuç bunu bildirir; uv lock davranışıyla eş tutulmaz.
- Tek bir child process'in exit 0 olması tek başına yeterli kanıt değildir; inventory/metadata sonkoşulları istenen değişikliğin gerçekten yapıldığını doğrular.

### Outstanding Questions

Ürün kararlarında açık blocker yoktur. Native flag birleşimleri, machine-output sürümleri ve platform process cleanup davranışı U4–U8'de gerçek fixture kanıtı gerektirir. Bunlar planlama sırasında çalıştırılmış veya doğrulanmış gibi sunulmaz. Kararlaştırılan işlemi karşılayamayan bir sürüm için capability hatası kabul edilir; altı manager'dan birinin temel adaptörünü tamamen ertelemek kabul edilmez.

---

## Implementation Units

### U1. Stable identity and complete workspace targeting

**Goal:** Her tool'un doğru projeyi ve ortak yazma alanını seçebilmesi.

**Requirements:** R1–R5, R20; AE1–AE2. **Dependencies:** Yok.

**Files:** src/inspect/model.ts, src/inspect/identity.ts (yeni), src/inspect/readers/manifest.ts, src/inspect/relationships.ts, src/inspect/scan.ts, tests/integration/discovery.test.ts, tests/integration/packaging/structure.test.ts, docs/inspection.md.

**Approach:** KTD1/KTD3 uygulanır. npm/Yarn/Bun native workspace deklarasyonları çözümlenir; üyelerin manager/version kanıtı ve lock owner'ı kaybolmaz. İç içe workspace'lerde en yakın doğrulanmış sahip seçilir. Mevcut id kullanan bütün call site ve fixture referansları birlikte değiştirilir.

**Test scenarios:**
1. Tekrarlanan scan, root kopyası, paket rename/version değişikliği aynı ID üretir; relative manifest taşıması farklı ID üretir.
2. Root nokta yolu, Unicode/boşluk içeren yollar ve aynı klasörde iki ekosistem çakışmaz.
3. Snapshot projeleri, members ve from/to referansları tutarlıdır; eski JSON cache olarak okunmaz.
4. npm/Yarn/Bun root/member, nested workspace, duplicate package name, exclude ve çelişen manager kanıtları doğru sonuç verir.
5. Dış root üyeliği ve symlink kaynakları işlem hedefi haline gelemez.

**Verification:** Snapshot schema 2 round-trip ve bütün eski discovery/packaging regresyonları geçer.

### U2. Dependency contracts and inventory

**Goal:** Agent'ın doğru grup/kaynak/sürüm hedefini seçebilmesi.

**Requirements:** R6–R11, R19; AE3–AE5. **Dependencies:** U1.

**Files:** src/dependencies/model.ts, schemas.ts, inventory.ts, adapters/types.ts (yeni); tests/unit/dependencies/schemas.test.ts, tests/integration/dependencies/inventory.test.ts (yeni).

**Approach:** Tool Interface ve KTD4/KTD5 tek doğrulama katmanına dönüştürülür. Native manifest okuyucuları grup/marker/source provenance'ını korur. Adaptör registry'si capability bildirir; shared schema her manager'a olmayan bir grup uydurmaz.

**Test scenarios:**
1. Eksik grup, boş listeler, bilinmeyen alanlar, wildcard, mode+version ve duplicate occurrence işlem öncesi reddedilir.
2. Aynı paket farklı gruplarda ayrı kayıt olarak döner; ambiguous update hangi seçimin gerektiğini söyler.
3. Manifest sürüm koşulu, çoklu lock resolution ve installed sürüm karıştırılmaz.
4. include_transitive kapalı/açık, eksik lock/cache, geçersiz native graph ve incomplete inventory görünürdür.
5. Registry/Git/path/workspace alanları ve root sınırları doğru doğrulanır; secret içeren URL raporda redakte edilir.

**Verification:** Bütün adapter'lar aynı sözleşmeyi karşılar; salt listeleme dependency metadata'sı veya ortam kurmaz.

### U3. Shared execution, queue and lifecycle

**Goal:** Native işlemlerin doğru scope'ta sonlanması ve gerçek etkilerinin raporlanması.

**Requirements:** R12–R20; AE6–AE9. **Dependencies:** U1–U2.

**Files:** src/dependencies/service.ts, queue.ts, runner.ts, executable.ts, changes.ts (yeni); src/packaging/get-structure.ts; tests/integration/dependencies/service.test.ts, runner.test.ts, queue.test.ts (yeni).

**Approach:** KTD6–KTD10 uygulanır. Process-global queue registry'si reload edilen modüllerde paylaşılır. Runtime upgrade eklemeden mevcut runtime'ın child_process/env özellikleri kullanılır. Root değişimi ve session lease ayrımı mevcut packaging lifecycle yaklaşımını izler.

**Execution note:** Önce gerçek kısa fixture process'leriyle iptal, pre-spawn failure ve queue terminal-path testleri kurulur; yalnız mock edilmiş exit sonuçları yeterli değildir.

**Test scenarios:**
1. Aynı lock iki session/modül kopyasında serial, bağımsız lock'lar paralel çalışır.
2. Queue beklerken workspace owner/manifest değişirse hedef yeniden çözülür; eski ID'ye yazılmaz.
3. Bekleyen isteğin iptali owner'ı öldürmez; çalışan child/grandchild bitmeden lease açılmaz.
4. Exec yokluğu, yanlış sürüm, nonzero exit, sinyal, session shutdown ve süreç başlamadan izin reddi queue'yu doğru sonlandırır.
5. Gürültülü stdout/stderr belleği sınırsız büyütmez; çıktı truncation açıkça bildirilir.
6. İki aşamalı native işlemde ikinci aşama hatası kısmi sonucu korur; refresh hatası native başarıyı silmez.
7. Corepack/pnpm/Go/uv bootstrap girişimi, global config değişikliği ve manager değiştirme yapılmaz.
8. Git olmayan fixture ve önceden değiştirilmiş manifestte yalnız çağrı sırasında oluşan metadata farkı raporlanır.

**Verification:** Kalıcı busy/disk lock oluşmaz; abort ve failure sonrası sonraki geçerli tool çalışabilir. Platformlarda tree cleanup kapsamı belgelenir.

### U4. uv adapter

**Goal:** Python dependency işlemlerinin native uv davranışıyla tamamlanması.

**Requirements:** R5–R14, R17–R19. **Dependencies:** U1–U3.

**Files:** src/dependencies/adapters/uv.ts, tests/unit/dependencies/adapters/uv.test.ts, tests/integration/dependencies/managers/uv.test.ts, tests/fixtures/dependencies/uv/ (yeni).

**Approach:** Native matrix ve KTD4/KTD5 izlenir. Group/extra/marker/source korunur; latest için yalnız lock upgrade bayrağının üst sınırı kaldırmadığı dikkate alınır. JSON graph schema sürümü doğrulanır.

**Test scenarios:**
1. Runtime/dev/named/extra kaynaklarına add/remove; aynı adlı başka grup ve marker tanımı korunur.
2. Within, upper bound, latest dış sınır, exact pin/downgrade ve solver conflict gerçek uv ile doğrulanır.
3. Registry, Git ref, local ve workspace source; inherited root sources ve seçili member doğru işlenir.
4. Locked sync eksik/stale lock'ta hata verir; optional seçimi native politika ile uyumludur.
5. Tree/list işleminde manifest/lock/venv değişmez; eksik Python indirilmez.

**Verification:** Hedef declaration, lock çözümü ve selected environment birlikte doğrulanır; herhangi bir eksik senaryo destek iddiasından gizlenmez.

### U5. npm and pnpm adapters

**Goal:** İki manager'ın grup ve workspace farklarını koruyarak JS dependency işlemleri sunmak.

**Requirements:** R5–R19. **Dependencies:** U1–U3.

**Files:** src/dependencies/adapters/npm.ts, pnpm.ts; tests/unit/dependencies/adapters/npm.test.ts, pnpm.test.ts; tests/integration/dependencies/managers/npm.test.ts, pnpm.test.ts; tests/fixtures/dependencies/npm/, pnpm/ (yeni).

**Approach:** Native matrix uygulanır. npm'in grup güvenli silmesi native pkg delete + install olabilir. pnpm catalog/override/specifier sahipliği korunur; registry paket adı manager/runtime yönetim komutu sanılmaz.

**Test scenarios:**
1. Bütün desteklenen gruplarda add/remove ve duplicate-group koruması.
2. Within/latest/exact downgrade; direct olmayan exact hedefe açıklayıcı hata.
3. Tek proje ve ortak-lock workspace; sibling manifestler, catalog ve manager metadata'sı korunur.
4. Dört source türü, yanlış workspace adı/sürümü ve registry fallback yokluğu.
5. Missing/stale lock sync, npm ci environment replacement ve no-bootstrap launcher.
6. Native manifest silme sonrası kurulum hatasında partial_change raporu.

**Verification:** Her manager'ın gerçek fixture'ları native dosya ve kurulum sonuçlarını doğrular; argv snapshot testleri tek kanıt değildir.

### U6. Yarn and Bun adapters

**Goal:** Classic/modern Yarn ve Bun'da scope'u kaybetmeden aynı tool sözleşmesini sunmak.

**Requirements:** R5–R19; AE8. **Dependencies:** U1–U3.

**Files:** src/dependencies/adapters/yarn-classic.ts, yarn-modern.ts, bun.ts; tests/unit/dependencies/adapters/yarn.test.ts, bun.test.ts; tests/integration/dependencies/managers/yarn-classic.test.ts, yarn-modern.test.ts, bun.test.ts; tests/fixtures/dependencies/yarn/, bun/ (yeni).

**Approach:** Varyantlar tek varsayımsal Yarn komutuna indirgenmez. Modern recursive resolution R18'e göre raporlanır. Native group-only remove mümkün değilse erken capability hatası; Bun'da native pkg delete iki aşamalı yolu kullanılabilir.

**Test scenarios:**
1. İki Yarn varyantında bütün temel operasyonlar; manifest formatı ve manager sürüm seçimi doğru.
2. Modern Yarn A/B'de aynı paket farklı range ile güncellenir; bütün manifestler aynı kalır, etkilenen resolutions raporlanır.
3. Latest/exact işlemi yalnız hedef declaration'ı değiştirir; kardeş manifesti değiştiren normal up kullanılmaz.
4. Duplicate-group remove native kapsamı aşamaz; Bun add gruplar arasında istemeden taşıyamaz.
5. Registry/Git/local/workspace kaynakları, özellikle Classic local-version uyuşmazlığında registry fallback kontrol edilir.
6. Yarn PnP ve node_modules, Bun text/binary lock, immutable/frozen sync ve eksik runtime durumları.

**Verification:** Her varyant kendi gerçek binary fixture'ında geçer; Yarn scoped-update davranışı R18'in kabul edilen sınırında kalır.

### U7. Go adapter

**Goal:** Go'nun module/minimum-version modelini doğru temsil ederek dependency işlemlerini desteklemek.

**Requirements:** R5–R14, R17–R19. **Dependencies:** U1–U3.

**Files:** src/dependencies/adapters/go.ts, tests/unit/dependencies/adapters/go.test.ts, tests/integration/dependencies/managers/go.test.ts, tests/fixtures/dependencies/go/ (yeni).

**Approach:** Native matrix uygulanır. require/replace/go.work farklı rolleri korunur. Sum dosyasından graph veya kurulu sürüm uydurulmaz. Toolchain ve import migration talepleri bu adaptörün normal package update'i değildir.

**Test scenarios:**
1. Direct/indirect/replaced modüller doğru ayrılır; unsupported dev/peer grubu before-spawn reddedilir.
2. Upgrade/latest farkı, exact downgrade, aynı-path major sınırı ve solver'ın diğer minimumlara etkisi.
3. Module+Git ref, local require/replace ve workspace üyesi bağımlılığı; sadece üyelik dependency sayılmaz.
4. Native remove sonrası otomatik tidy yapılmaz; kaynak import'ları değiştirilmez.
5. Warm/cold-cache transitive list, missing sums ve unavailable graph; read-only sorgu gerçek dosyaları değiştirmez.
6. Sync checksum/native manifest etkileri raporlanır; toolchain download ve dış GOWORK engellenir.

**Verification:** Seçilmiş module sürümleri gerçek Go sonucu ile karşılaştırılır; uv/npm lock modeli Go'ya taşınmaz.

### U8. OMP tools, packaged smoke and documentation

**Goal:** Agent'ın kurulu extension üzerinden bütün işlemleri keşfedip doğru sonuçları okuyabilmesi.

**Requirements:** R1–R20. **Dependencies:** U1–U7.

**Files:** src/omp/extension.ts, src/omp/dependency-tools.ts (yeni), src/index.ts, package.json, README.md, docs/dependencies.md (yeni); tests/integration/omp/host.ts, extension.test.ts, installed-smoke.test.ts; tests/integration/omp/dependencies.test.ts, tests/fixtures/dependencies/manager-versions.json (yeni).

**Approach:** Mevcut session root/abort/refcount davranışı ortaklaştırılır. list_projects temel keşif tool'u olarak erişilebilir tutulur; bağımlılık tool description'ları önce hedef ID ve inventory alma akışını anlatır. Paket manifesti yeni export/docs dosyalarını içerir. Kurulumdan sonra tests dizinine veya checkout path'ine bağımlılık kalmaz.

**Test scenarios:**
1. list_projects sıfır parametreyle yalnız istenen iki alanı content içinde döndürür; no-project sonucu boş listedir.
2. Agent akışı list_projects → dependency_list → add/update/remove/sync, gerçek OMP runner ile çalışır.
3. Exec onayı reddi spawn veya dependency mutasyonu yapmaz; structured hata model-visible olur.
4. Session root change/shutdown, queue bekleyen ve çalışan farklı çağrılarla doğru davranır.
5. Paketlenip checkout dışında yüklenen extension bütün modülleri içerir ve izole fixture'da mutasyon yapar.
6. Her manager/varyant için hangi exact binary sürümünün kanıt sağladığı kayıtlıdır; eksik manager testleri sessiz passed/skip kabul edilmez.

**Verification:** Mevcut inspection tool'u ve yeni altı tool gerçek OMP'de geçer. README ile capability/semantics dokümanı gerçekte doğrulanan davranışla eşleşir.

---

## Verification Contract

Uygulama sırasında mevcut bun run check (strict TypeScript, Biome, unit) ve bun run test:integration kapıları korunur. Yeni manager testleri ayrı seçilebilir script/grup olarak eklenebilir; mevcut kapılar sessizce hafifletilmez. Bu planlama aşamasında test veya manager mutasyonu çalıştırılmamıştır.

Gerçek-manager test ortamı, kullanıcı proje/cache/global config'lerinden ayrılmış geçici fixture'lar kullanır. Manager binary'leri test harness tarafından ayrıca hazırlanabilir; bu, ürünün R17 no-install sözleşmesinden ayrıdır. Registry sürümleri kontrollü fixture registry/proxy'den, Git/local/workspace kaynakları geçici yerel kaynaklardan gelir. Public latest sonuçlarına bağlı kırılgan test yazılmaz.

Doğrulama katmanları:

1. Saf şema/identity/capability testleri; malformed input için native süreç hiç başlamaz.
2. Gerçek subprocess ile queue, iptal, çıktı sınırı ve partial change testleri.
3. Her manager/varyant için gerçek native add/remove/list/update/sync ve dört kaynak fixture'ı.
4. Gerçek OMP loader/approval/installed-package smoke; yalnız sahte registry üzerinden tool çağırmak yeterli değildir.
5. Mevcut inspection/config/watcher/regression suite'i; yeni kimlik ve workspace desteği dışlamaları veya cache davranışını bozmaz.

Minimum native senaryo matrisi her varyantta within_constraints, latest, exact upgrade/downgrade, missing executable, version mismatch, unsupported capability, shared lock ve grup izolasyonunu kapsar. Native destek olmayan hücrede sıfır yazıyla açıklayıcı hata beklenir. Temel manager adaptörünü yalnız unsupported döndürerek tamamlanmış saymak yasaktır.

Destek iddiası platform kanıtını da belirtir. macOS/Linux child-tree iptal testleri yürütülür; Windows desteği iddia edilecekse ilgili runner ve manager smoke ayrıca geçer. Koşulamayan senaryo eksik doğrulama olarak raporlanır.

---

## Definition of Done

- U1–U8'in davranış ve gerçek integration kanıtları tamamdır; R1–R20 ile AE1–AE9 karşılanır.
- İlk sürümün altı manager'ı, iki Yarn varyantı ve dört source ailesi native capability sınırlarıyla çalışır.
- JSON/tool kimlikleri aynı kanonik değeri taşır; list_projects response'u gereksiz metadata ile genişlemez.
- Grup ve kaynak sessizce değişmez; exact/mode/explicit-packages sözleşmeleri uygulanır.
- İptal/failure/permission denial sonrası queue doğru kapanır; kalıcı busy mekanizması yoktur.
- Başarısız veya kısmi mutasyon, başarılı mutasyon ve başarısız refresh açıkça ayrılır.
- Gerçek tool onayları ve native script politikaları korunur; eksik manager otomatik kurulmaz.
- Dokümanlar desteklenen sürümleri, ortak-lock etkilerini, Go farklarını ve bilinen capability hatalarını açıklar.
- Deneme kodu, yarım alternatif, hassas çıktı ve fixture kalıntısı teslim diff'inde bırakılmaz.
- Kodun yazılması veya yayınlanması bu planın hazırlanmış olmasıyla başlamaz; kullanıcı uygulamayı ayrıca onaylar.

---

## Sources and References

Mevcut repo kanıtları: src/inspect/readers/manifest.ts:38–54,163–183; src/inspect/model.ts; src/inspect/relationships.ts; src/inspect/scan.ts:155–201; src/packaging/get-structure.ts; src/omp/extension.ts. Önceki kapsam: .compound-engineering/artifacts/plans/2026-10-28-1823-feat-on-demand-project-inspection-plan.md.

OMP API/lifecycle kanıtı package.json/bun.lock ile sabitlenmiş @oh-my-pi/pi-coding-agent 18.13.3 types.ts, wrapper.ts, runner.ts ve exec/exec.ts kaynaklarından alınmıştır. pi-utils runtime alt sınırı ayrıca kendi package.json metadata'sında kontrol edilmiştir.

- uv: [dependency yönetimi](https://docs.astral.sh/uv/concepts/projects/dependencies/), [lock/sync](https://docs.astral.sh/uv/concepts/projects/sync/), [CLI](https://docs.astral.sh/uv/reference/cli/), [workspace](https://docs.astral.sh/uv/concepts/projects/workspaces/).
- npm: [update](https://docs.npmjs.com/cli/update.html/), [pkg](https://docs.npmjs.com/cli/v11/commands/npm-pkg/), [ls](https://docs.npmjs.com/cli/v11/commands/npm-ls/), [ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/), [workspace](https://docs.npmjs.com/cli/v11/using-npm/workspaces/).
- pnpm: [add](https://pnpm.io/cli/add), [remove](https://pnpm.io/cli/remove), [update](https://pnpm.io/cli/update), [list](https://pnpm.io/cli/list), [install](https://pnpm.io/cli/install).
- Yarn Classic: [upgrade](https://classic.yarnpkg.com/lang/en/docs/cli/upgrade/), [remove](https://classic.yarnpkg.com/lang/en/docs/cli/remove/), [workspace](https://classic.yarnpkg.com/lang/en/docs/workspaces/).
- Yarn modern: [up](https://yarnpkg.com/cli/up), [add](https://yarnpkg.com/cli/add), [remove](https://yarnpkg.com/cli/remove), [info](https://yarnpkg.com/cli/info), [install](https://yarnpkg.com/cli/install).
- Bun: [update](https://bun.sh/docs/pm/cli/update), [add](https://bun.sh/docs/pm/cli/add), [pm/pkg](https://bun.sh/docs/pm/cli/pm), [workspace](https://bun.sh/docs/pm/workspaces), [install](https://bun.sh/docs/pm/cli/install).
- Go: [module reference](https://go.dev/ref/mod), [dependency yönetimi](https://go.dev/doc/modules/managing-dependencies), [go.mod](https://go.dev/doc/modules/gomod-ref), [source/checksum](https://go.dev/doc/modules/managing-source), [toolchain](https://go.dev/doc/toolchain), [download kaynak kodu](https://go.dev/src/cmd/go/internal/modcmd/download.go).
- Launcher davranışı: [Corepack](https://github.com/nodejs/corepack), [pnpm version management](https://pnpm.io/10.x/settings#managepackagemanagerversions).
