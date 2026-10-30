---
title: Test kanıtını koruyarak entegrasyon maliyetini azaltma
type: refactor
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Test kanıtını koruyarak entegrasyon maliyetini azaltma

## Goal Capsule

**Amaç:** Justomp geliştirme ve gelecekteki PR kontrollerinde, aynı davranışı pahalı araç kurulumlarıyla tekrar kanıtlamadan güvenilir ve kısa geri bildirim almak. İkinci amaç, aynı test tasarımı hatasının sonraki özelliklerde tekrarlanmasını önleyecek kalıcı CE kurallarını oluşturmak.

**Yöntem:** Her mevcut testin kanıtladığı davranışı eşlemek; saf karar/ayrıştırma varyasyonlarını unit testlere almak; gerçek dosya sistemi, süreç, paket yöneticisi ve derleyici sınırlarını gerektiği yerde korumak; tekrarlanan framework matrislerini daraltmak; kurulum maliyetini ölçerek güvenli fixture paylaşımı yapmak.

**Yetki:** Kullanıcı bu planın ce-work ile uygulanmasını ve pack aktivasyonunu onayladı. Daha sonra üretimdeki tekrarlanan sorguların azaltılmasını da ayrıca onayladı. Son yönlendirme, saf karar ve çıktı varyasyonlarının unit testlere taşınmasına ve entegrasyonda gerçek akışların tutulmasına öncelik veriyor. Commit/push veya CI yayımı için onay yok. Mevcut staged/unstaged çalışmalar korunuyor.

**Durma koşulları:** Bir sınırın tek gerçek kanıtı kaybolacaksa, başarı yalnız test atlama/özellik daraltmayla mümkünse veya geçerli karşılaştırmalı ölçüm yapılamıyorsa iyileşme ilan edilmez. Eksik kanıt veya bütçeye ulaşamama açıkça raporlanır.

## Product Contract

### Requirements

- **R1 — Davranış korunur.** Inspection, dependency, lint ve typecheck API/CLI/OMP sözleşmeleri; desteklenen ekosistemler, paket yöneticileri, strict kurallar, workspace etkileri ve hata/iptal davranışları değişmez. Önceki lint/typecheck planları ürün davranışı için kaynak olmaya devam eder.
- **R2 — Kanıt devri izlenir.** Pahalı bir test silinmeden/daraltılmadan önce davranışı, yeni alt seviye testi ve hâlâ gerekli gerçek sınır testi isimleriyle eşlenir. Test adedini azaltmak veya unit/integration oranı tek başına başarı ölçütü değildir.
- **R3 — Test katmanı kapsamla seçilir.** Saf hesaplama, parser, config dönüşümü ve sonuç eşleme varyasyonları unit; gerçek FS/watchers/queue/process etkileşimleri integration; gerçek paket yöneticisi/derleyici davranışı native integration olur. Sürenin kısa olması integration testini unit yapmaz.
- **R4 — Hata kanıtı korunur.** Hata senaryosu otomatik olarak unit sayılmaz. Gerçek child/grandchild sonlandırma, yarım kurulumun manifest/lock etkisi, native çözümleme/PnP hatası ve üretilecek dosyanın eksik kalması gerçek sınır kanıtı gerektirebilir. Buna karşılık aynı ProcessResult'ın farklı mesajlara çevrilmesi unit ile kanıtlanır.
- **R5 — Tüm destekler temsil edilir.** npm, pnpm, Yarn Classic, modern Yarn, Bun, uv ve Go'nun kendilerine özgü kurulum, lock, group, workspace ve çalıştırma davranışları testte kalır. Ortak dil kuralları bütün yöneticilerde aynı geniş matrisle tekrarlanmaz.
- **R6 — İzolasyon korunur.** Bağımsız testlerin yazılabilir proje kökü, manifest/lock, config/state, watcher ve process sahipliği ayrıdır. Paylaşılan indirme verisi bir testin ilk kurulumunu veya doğruluk kontrolünü atlatamaz.
- **R7 — Karşılaştırma dürüst olur.** Başarılı, tam ve aynı koşullardaki önce/sonra koşuları karşılaştırılır. Soğuk/sıcak önbellek, ortam ve gerçek kurulum maliyeti belirtilir. Başarısız/erken bitmiş koşu başarı baz çizgisi olamaz.
- **R8 — Gerekli testler normal doğrulamada kalır.** Bütçeye ulaşmak için skip, retry ile hata gizleme, timeout artırma, yalnız nightly'ye taşıma veya daha çok paralel makineyle toplam işi saklama yapılmaz.
- **R9 — Tekrarlamayı önleme kalıcı olur.** CE pack kuralları, açık repo aktivasyonu, kısa AGENTS ilkesi ve ölçüm kontrolü birlikte kullanılır. Pack'in tüm host ve kısa review yollarında otomatik çalıştığı iddia edilmez.
- **R10 — Değişiklik sınırı korunur.** Bu iş test tasarımı, gerekli dar iç modül ayrımları, test harness'i, doğrulama komutları ve ilgili dokümantasyonla sınırlıdır. Üretim freshness/approval/guard davranışı performans amacıyla zayıflatılmaz.

### Kullanım akışları ve kabul örnekleri

- **F1 / AE1 — Yeni davranış ekleme:** Agent önce hangi saf kararı ve hangi gerçek sınırı değiştirdiğini belirtir. Örneğin 20 farklı bozuk compiler çıktısı, 20 ayrı TypeScript kurulumu gerektirmez; parser birimleri ve gerçek çıktı biçimini doğrulayan sınır testi yeterlidir.
- **F2 / AE2 — Mevcut testi taşıma:** Eski testin her ayrı iddiası bir hedef teste bağlanır. Gerçek süreç ağacının öldüğünü doğrulayan assertion, mock'un `cancel` çağrıldı sayacıyla değiştirilemez.
- **F3 / AE3 — Yeni/boş ortamda çalıştırma:** İndirme önbelleği boşken de aynı gerekli senaryolar çalışır. Cache bulunmaması skip veya sahte hazır-state üretmez.
- **F4 / AE4 — Çok projeli ortam:** Aynı tool payload'ını kullanan iki proje kendi manifest/lock/state'ine sahiptir; birinin değişimi diğerinin başarılı sonucunu geçersiz biçimde taşımaz.
- **F5 / AE5 — Gelecek plan/review:** Yeni native test önerisi gerçek sınırı, daha ucuz katmanın neden yetmediğini ve setup maliyetini açıklar. Saf config/parser varyasyonunu tekrar kurulumlu entegrasyona koyan plan pack incelemesinde düzeltilir.

**Kapsam dışı:** Yeni ürün özellikleri, typecheck/lint araçlarının sürümünü değiştirme, genel test framework'ü, kapsam yüzdesi kotası, yeni guard/lock sistemi, CI sağlayıcısı seçimi, otomatik yayın ve pack'i bütün kullanıcının repolarına kurma.

## Planning Contract

### Mevcut durum ve ölçüm

Araştırma 2026-10-29 tarihinde mevcut kaynak ve önceki test logları üzerinden yapıldı; bu plan için test veya kurulum çalıştırılmadı. Repoda henüz `.github` workflow'u yok. Dolayısıyla aşağıdaki süre **CI süresi değildir**.

`/private/tmp/justomp-typecheck-full-integration.log`: **413 pass, 1 fail, 414 test; 1074.27 saniye (17 dakika 54 saniye).** Hatalı references senaryosu 39.32 saniyede erken bitti. Beklenti düzeltildikten sonraki tam odaklı koşu 133.60 saniye sürdü. Sonradan eklenen local-package ve corrupt-state senaryoları da eski tam koşuda yok. Bu log yalnız maliyetin yerini gösterir; güncel yeşil baz çizgisi değildir.

| Mevcut dosya (`tests/integration/`) | Eski logda test süreleri toplamı |
| --- | ---: |
| `typecheck/next.test.ts` | 193.48 s |
| `typecheck/references.test.ts` | 181.10 s; erken hata var |
| `lint/javascript.test.ts` | 138.52 s |
| `typecheck/service.test.ts` | 113.27 s |
| `typecheck/javascript.test.ts` | 91.45 s |
| `omp/installed-smoke.test.ts` | 54.50 s |
| `typecheck/mixed-repository.test.ts` | 41.73 s |

İlk beş dosya gözlenen sürenin yaklaşık %67'sini oluşturuyor. Buna karşılık typecheck concurrency/provisioning/lifecycle toplamı yaklaşık 0.66 saniye; gerçek etkileşim testleri olmalarına rağmen zaten ucuzlar. İlk öncelik bunları yeniden mimarileştirmek değil, yukarıdaki tekrarları kaldırmaktır.

Çalışma ağacında 52 integration ve 14 unit test dosyası bulunuyor. Eski logun footer'ında başarısız test tekrar yazıldığı için basit satır sayımı çift sayabilir; parser başarısız-test özetinden sonraki tekrarı saymamalı. Güncel test sayısı U1'de gerçek envanterden doğrulanacak.

### KTD1 — Üç kanıt grubu, mevcut modül düzeni

Unit ve integration ayrımı korunur. Integration içinde **yerel etkileşim** ve **native araç** grupları dosya bazında ayrılır; modül klasörleri korunur. Karma dosya gerçekten ayrıştırılır: yerel dosya `*.test.ts`, gerçek araç dosyası `*.native.test.ts` olarak adlandırılır. Mevcut `test:integration` bütün integration ağacını çalıştırmaya devam eder; mevcut feature scriptleri aynı toplam kapsamı korur.

İlk optimizasyon test keşfi için yeni registry/DSL oluşturmaz. Ölçüm raporu dosya adından grubu çıkarır; bir native dosyanın taşınması/silinmesi R2 eşlemesine bağlıdır. Yerel testte kontrollü gerçek child process veya loopback registry olabilir. Native testin internetsiz çalışması onu unit yapmaz.

### KTD2 — Saf kararlar üretimin kullandığı dar iç modüllere alınır

Mevcut `TypecheckAdapter`, injection fixture'ları, config-graph, versions ve projection fonksiyonları önce kullanılır. Gerekirse diagnostic normalization, outcome composition veya graph planning ayrılır; public export, test-only setter, ikinci fake runtime ya da TypeScript resolver taklidi yazılmaz.

Unit oracle bağımsız beklenen sonuçtur; üretim algoritmasının aynısı mock içinde tekrar uygulanmaz. Kaydedilmiş gerçek çıktı örnekleri hangi tool sürümünden geldiğiyle tutulur. Native sentinel gerçek çıktının parser ve adapter sözleşmesiyle hâlâ uyumlu olduğunu kanıtlar.

### KTD3 — Manager kanıtı ve framework semantiği ayrılır

JS lint'teki typed TS/React/a11y/Next matrisinin tamamı beş manager'da yeniden kurulmayacak. Her manager gerçek kurulum, doğru binary/plugin çözümleme ve küçük lint/format/typecheck çağrısı ile temsil edilir. Geniş ortak semantik matrisi npm üzerinde; PnP/plugin çözümleme farkı modern Yarn üzerinde kalır. pnpm özel modules/store/lock yerleşimi ayrıca korunur.

Typecheck'in gerçek TS5 PnP başarısı, TS7 uyumsuzluğu ve eski Yarn patch hatası destek sınırı kanıtıdır. Hız için silinmez veya araç sürümü düşürülmez. Dependency manager testlerinin çoğu zaten küçük yerel registry kullanıyor; bunlar geniş framework tekrarlarıyla aynı problem değildir.

### KTD4 — Kurulum ve senaryo hazırlığı ölçülerek ayrılır

Önce mevcut fixture kurulum/projection/native-check/cleanup aşamaları ölçülür. Aynı run içinde değişmez tarball/paket indirme içerikleri yeniden kullanılabilir. Her bağımsız yazma senaryosu ayrı proje kökü alır; dedicated installation/upgrade senaryosu gerçekten hazırlıksız proje üzerinden native manager'ı çalıştırır.

`.venv`, node_modules, PnP loader veya readiness receipt körlemesine kopyalanmaz/hardlinklenmez: shebang, symlink ve mutlak yollar köke bağlı olabilir. Öncelik manager'ın kendi indirme cache'i ve izole kurulumu; ancak somut taşınabilirlik kanıtı varsa daha ileri paylaşım. Yeni kalıcı cache servisi yapılmayacak. Cache anahtarları runtime/platform/architecture, manager/tool sürümleri ve fixture lock girdilerini ayırır.

Bir gerçek yaşam döngüsü kaynak değişimi → stale → repair adımlarını aynı fixture'da taşıyabilir. Bağımsız testler önceki testin mutation'ına bağımlı yapılmaz. Suite'i tek dev teste dönüştürüp ilk failure'ın sonraki kanıtları gizlemesine izin verilmez.

### KTD5 — Paralellik ilk çözüm değildir

Mevcut testler `process.env`, `globalThis.fetch`, module spies ve global packaging lifecycle üzerinde değişiklik yapıyor. Aynı process içinde toplu concurrency açılmayacak. Önce aynı concurrency ile gerçek tekrar ve kurulum işi azaltılır. Daha sonra ayrıca gerekirse process izolasyonu değerlendirilir; bu planın hedefini karşılamak için ekstra worker kullanılmaz.

### KTD6 — Süre hedefi ve geçerli karşılaştırma

**Önerilen mühendislik kabul hedefi:** Aynı makine/runtime/tool sürümlerinde, sıcak indirme cache'i fakat her koşuda taze yazılabilir fixture'larla **tüm gerekli doğrulama ≤300 saniye** ve başarılı önceki baz çizgisine göre **en az %60 düşüş**. Bu kullanıcı tarafından önceden onaylanmış veya ölçümle garanti edilmiş sonuç değildir; bu planla sunulan hedeftir.

Kapsam `check` (typing, lint, unit) ve bütün gerekli integration testlerinin toplam uçtan uca süresidir. Test fixture kurulumları, package smoke ve cleanup dahildir. Bir defalık çalışma ortamı/bootstrap ayrıca gösterilir; toplam soğuk süre de raporlanır. Dış registry erişim hatası performans başarısı sayılmaz.

Soğuk cache koşusu bütün gerekli kanıtı çalıştırmalı; sıcak koşuyla karıştırılmaz. Gelecekteki CI runner'ının kaynakları bilinmediğinden 300 saniye bu ortam için hedef olur. CI kurulurken aynı ölçüm yöntemiyle runner üzerinde kalibre edilir; bu iş CI workflow'u yayımlamaz. Hedef tutmazsa kalan maliyet ve korunması gereken kanıtla kullanıcıya dönülür; başarı eşiği sessizce yükseltilmez.

### KTD7 — Tekrarlamayı önleme: pack + kısa politika + ölçüm

CE 3.30.4'te pack, tekrar kullanılan **kural bilgisidir**; learning ise çözülmüş olayın geriye dönük açıklamasıdır. Bu problem tekrar eden test tasarımı kararı olduğu için pack uygundur. Aşağıdaki dosyalar ancak implementasyon onayından sonra oluşturulur:

| Dosya | Sorumluluk |
| --- | --- |
| `compound-packs/testing/test-evidence-and-cost.md` | Kanıt katmanı ve maliyet için tek ayrıntılı kural |
| `.compound-engineering/config.yaml` | Repo-relative `packs` girdisiyle aktivasyon; `docs_root` mevcut `.compound-engineering/artifacts` köküne ayarlanır |
| `AGENTS.md` | Doğrudan çalışmalarda ve kısa review yollarında da görülen kısa ilke ve canonical pack bağlantısı |
| `.compound-engineering/artifacts/solutions/…` | Yalnız çözüm ölçülüp doğrulandıktan sonra ce-compound ile olaydan çıkarılan gerekçe ve önce/sonra kanıtı |

Pack kuralı en üst seviyede `.md` dosyası olmalı; frontmatter'da `title` ve `applies_when` bulunmalı. Eşleşme koşulu test ekleme, taşıma, review, harness ve doğrulama süresi değişikliklerini kapsar. README veya alt klasöre saklanan kuralın keşfedileceği varsayılmaz.

Kuralın zorunlu içeriği:

1. Her yeni pahalı entegrasyon için **davranış / gerçek sınır / unit neden yetmiyor / korunacak assertion / setup maliyeti** belirtilir.
2. Saf happy-path ve hata varyasyonları aynı alt seviye kontratta test edilir; yalnız gerçek bileşen etkileşimi gerektiren varyasyon yukarı çıkar.
3. Aynı kanıt API, CLI, host ve manager matrislerinde tekrar kurulmaz; her katman kendi wiring sınırını kanıtlar.
4. Gerçek failure, cancellation, partial-write ve compiler-resolution kanıtı “hata testi” olduğu için mock'a çevrilemez.
5. Silinen testin yerine geçen kanıt isimle gösterilir; test sayısı başarı ölçüsü değildir.
6. Yeni kurulumlu testte ölçülen süre ve cache davranışı review'e girer. Kapsam azaltma/bütçe değiştirme kullanıcı kararıdır.

Kısa AGENTS ilkesi bu kuralı işaret eder ve yeni entegrasyonun boundary gerekçesini zorunlu kılar; ayrıntılı policy iki dosyada çoğaltılmaz. CE plan/brainstorm ve full code-review matching pack'i kullanabilir. `ce-work` plan referansları üzerinden uygular. Lite/focused review yolları ve her host otomatik pack yüklemez; bu nedenle AGENTS fallback ve deterministik ölçüm gerekir. Başka bir repoda kullanım için o repoda da açık pack aktivasyonu gerekir. Plugin cache dosyaları değiştirilmez.

**Sınır:** Pack bir çalışma zamanı enforcement veya modelin hata yapmayacağı garantisi değildir. Süre gate'i de semantik test kalitesini tek başına ölçmez. Review'deki kanıt eşlemesi ve ölçüm birlikte çalışır. Henüz sorun çözülmediğinden bugün “çözüldü” learning'i yazılmaz; ce-compound U7 sonunda doğrulanmış sonucu kaydeder.

### Sistem etkisi ve korunacak sınırlar

Public API, CLI exit/JSON ve OMP tool schema değişmez. Bir result-builder ayrımı bu üç yüzeyin aynı sonuçları taşımasını korumalıdır. Paket dışından export/bin/resource yükleme gerçek installed smoke ile; host onay/red ve session/root değişimi gerçek OMP sınırında kalır. Üretim koordinatörünün readiness/freshness kontrolünü kaldırmak fixture optimizasyonu değildir.

Korunacak asgari native kanıt: her manager'ın gerçek işlem/lock davranışı; Python strict kaynak+test, stub/interpreter/import ayrımı; JS strict/alias/context ve PnP; declaration graph/eksik çıktı/mixed-JS; Next typegen/custom path/dynamic closure/config cancellation; Go kaynak+test derleme ve testlerin çalışmaması; lint/typecheck sürüm etkileşimi; installed package çalışması. Ayrıntılı dosya eşlemesi Ek'tedir.

## Implementation Units

### U1. Kanıt envanteri ve başarılı baz çizgisi

**R1–R2, R7; bağımlılık yok.** Mevcut bütün unit/integration testleri davranış bazında listelenir; eski typecheck planı ve düzeltme regresyonlarıyla çapraz kontrol edilir. Her eski test için `kalır / bölünür / yerine şu geçer` kararı ve gerçek sınır sentinel'i kaydedilir. Tablo özel çalışma notu olarak `.private/test-evidence-cost/` altında tutulur; sonuçta kalıcı gerekçe pack/learning'e taşınır.

Dosyalar: `tests/integration/**`, `tests/unit/**`, fixture helper'ları, `package.json`. Eski logun sonucu ve current tree farkı kaydedilir. Önce bilinen odaklı düzeltmelerin yeşil olduğu doğrulanır; ardından bir kez tam başarılı baz çizgisi alınır. Üretim değişikliği yapılmaz.

**Doğrulama:** Ölçümde eksik/failed/skipped test varsa baz çizgisi geçersizdir. Dizin/env/Bun/manager/tool sürümleri, cache koşulu, duvar süresi ve senaryo sayısı kayda girer. Fixture setup/check/cleanup maliyetleri ayrıştırılır. U1 tablosunda hiçbir eski davranış sahipsiz kalmaz.

### U2. Saf mantık ve sonuç varyasyonlarını unit katmanına taşıma

**R2–R4, R10; U1 sonrası.** Önce typecheck service/outcome ve lint diagnostic/config matrisleri ele alınır; kolay ama milisaniyelik dosyaları taşımak hız işinin merkezine konmaz.

Hedefler: `src/typecheck/service.ts`, `src/typecheck/adapters/`, `src/typecheck/javascript/prepare-types.ts`, `src/lint/adapters/`, mevcut versions/config/projection modülleri. Yeni dar iç parser/result modülleri gerektiğinde mevcut servis klasörlerinde kalır. Test hedefleri `tests/unit/typecheck/`, `tests/unit/lint/`, `tests/unit/dependencies/`.

**Senaryolar:** Bozuk/truncated/empty/crash çıktı; cancellation sonrası tamamlanmış diagnostic'in korunması; registry stable/yanked seçimleri; graph cycle/collision/ambiguous çıktı; TOML/JSONC dönüşümü; strict rule/default/override eşlemesi. Girdi ve beklenen sonuç sabittir; gerçek kurulum ve dosya sistemi yoktur. FS persistence, symlink veya process iddiası taşıyan kısmı yerel integration olarak bırak.

**Doğrulama:** Üretim aynı ayrılmış fonksiyonu kullanır; public sonuçlar değişmez. Eski regresyonu temsil eden küçük kontrollü hata yeni testte yakalanabilir olmalı; her taşınan case için dev mutation framework'ü kurulmaz. Yeni alt seviye test yeşil ve uygun retained boundary mevcut olmadan eski pahalı assertion silinmez.

### U3. Fixture maliyetini azaltma ve izolasyonu koruma

**R5–R7; U1 sonrası, U2 ile aynı tasarım sınırları.** `tests/fixtures/lint/javascript/fixture.ts`, `tests/fixtures/typecheck/generated/fixture.ts`, dependency manager fixture'ları ve dil fixture'larında ölçülen tekrarlar azaltılır. Manager bootstrap ve değişmez tarball üretimi run başına paylaşılabilir; package availability/publish state ve yazılabilir consumer root paylaşılamaz.

**Senaryolar:** Aynı payload kullanan iki taze fixture birbirini kirletmez; bir fixture'ın bozulması diğerinin kurulumuna geçmez; soğuk cache normal kurulum yapar; kapanan fixture'ın watcher/child'ı kalmaz. Mutlak root taşıyan environment için güvenli fallback manager-native kurulumdur.

**Doğrulama:** Dedicated fresh install, upgrade, failed install ve native executable resolution kanıtları çalışır. Tek temel fixture izolasyon testi ve mevcut cleanup kanıtları yeterlidir; her yardımcı fonksiyon için yeni pahalı test matrisi üretilmez. Setup/native invocation sayısı U1 ile karşılaştırılır.

### U4. Dil/framework matrislerindeki tekrarları birleştirme

**R1–R6; U2 ve U3 sonrası.** Öncelik sırası: `lint/javascript.test.ts`; `typecheck/next.test.ts`; `typecheck/references.test.ts`; `typecheck/service.test.ts`; `typecheck/javascript.test.ts`; sonra mixed suites ve dil outcome dosyaları.

Next default/custom path için aynı stale/fix/delete/repair yaşam döngüsü iki kere ve service katmanında üçüncü kez kurulmaz. Bir retained Next senaryosu public API üzerinden geçerek service wiring'i de kanıtlar; özel path/dynamic closure/loader cancellation ayrı gerçek sınırlar olarak kalır. Declaration chain, missing-output regeneration, mixed-JS emit ve configless local package regresyonları korunur.

**Senaryolar:** Ek'teki her native sentinel, ilgili ürün kontratını gerçek araçla kanıtlar. Genel error/format/result varyasyonları U2'deki yeni testlere taşınır. Manager-specific PnP/pnpm/uv farkı ortak npm sentinel'iyle değiştirilmez.

**Doğrulama:** U1 mapping güncellenir; hiçbir destek veya regresyon sadece mock ile temsil edilir hâle gelmez. Odaklı retained native dosyaları çalıştırılır. Bütün suite her dosya değişiminden sonra tekrar çalıştırılmaz.

### U5. API, CLI, OMP ve installed smoke kapsamını sadeleştirme

**R1–R4, R6; U2–U4 sonrası.** `tests/integration/omp/`, lint/typecheck CLI ve service dosyaları kendi transport/lifecycle sorumluluğuna daraltılır. Approval/schema/unknown ID ve ownership varyasyonları için gerçek host + mevcut injected adapter kullanılır; bunlar yerel integration olarak sınıflanır.

Installed smoke paketlenmiş ürünü checkout dışında gerçekten kurmaya devam eder. Export/bin/docs/formatter resource varlığı ve gerçek host registration korunur; tek temsilî native sonuç zinciri yeterlidir. Diğer transportlarda semantik katalog yeniden çalıştırılmaz; entrypoint'in çağrılabilirliği, serialization/exit ve shared result contract doğrulanır.

**Senaryolar:** Gerçek host red; startup/new project handoff; root switch/shutdown child join; gerçek CLI JSON ve exit; installed consumer'ın checkout'a yanlışlıkla yaslanmaması. Generic queue/cancel varyasyonları existing cheap concurrency/runner testlerine bağlanır.

**Doğrulama:** Native compiler gerektirmeyen host senaryosunda paket kurulumu yapılmaz. Tek gerçek installed proof korunur; source import tek başına onun yerine geçmez.

### U6. Doğrulama komutları, ölçüm ve süre bütçesi

**R3, R7–R8; U4–U5 sonrası.** `package.json` mevcut check/integration/feature komutlarının kapsamını korur. Tek yeni ölçüm komutu `check` ve tam integration traversal’ını birer kez çalıştırıp toplam süre ve dosya/grup maliyetini raporlar; test listesini kendine ait ikinci bir doğruluk kaynağına dönüştürmez. Script ve README test açıklaması eklenir; burada CI workflow'u kurulmaz.

Feature alias’ları bu ölçüm için art arda çalıştırılmaz: mevcut `test:dependencies` bütün OMP dizinini de kapsıyor; lint/typecheck alias’larıyla birleştirmek aynı testleri tekrar çalıştırır. Gerekli gate yalnız `check` + bir tam integration geçişidir. Keşfedilen testlerin U1 retained envanteriyle eşitliği doğrulanır.

Bun'un JUnit reporter'ı makinece okunabilir test sürelerini verebilir; kurulu Bun sürümündeki destek implementation sırasında doğrulanır. Komutun dışından toplam wall ölçümü fixture ve komutlar arası maliyeti de kapsar. Console log regex'i tek uzun vadeli veri kaynağı yapılmaz. [Bun reporter dokümanı](https://bun.sh/docs/test/reporters)

**Senaryolar:** Hatalı child exit gate'i fail eder; başarısız/eksik rapor hız başarısı sayılamaz; 300 saniye eşiğinin altı/üstü süre hesabı küçük saf birimlerle kontrol edilir. Sayaç için gerçek 5 dakika bekleyen test yazılmaz. Wrapper bütün integration dizinini çalıştırır; yeni native dosya eklemek ayrıca liste güncellemesi gerektirmez.

**Doğrulama:** Önce bir taze-cache tam koşu, sonra aynı sürümlerle üç sıcak-cache tam koşu; medyan ve dağılım raporlanır. Bunlar son kabul ölçümüdür, günlük her editte tekrarlanmaz. KTD6 sağlanmadıysa iş performans açısından tamamlandı sayılmaz; kalan darboğaz ve öneri kullanıcıya verilir. Gelecekte CI aynı ölçüm girişini kullanabilir; gerçek runner kanıtı olmadan CI süresi iddia edilmez.

### U7. CE önleme kuralını yerleştirme ve doğrulanmış öğrenimi kaydetme

**R9; policy taslağı U1'den sonra, nihai öğrenim U6'dan sonra.** KTD7 dosyaları oluşturulur. Mevcut config varsa merge edilir; kullanıcı ayarları ezilmez. AGENTS varsa mevcut politika korunarak kısa bölüm eklenir. Host-specific dosyalara ikinci policy kopyası yazılmaz.

**Doğrulama:** Kurulu CE pack resolver kuralı bulur; test ekleme/refactor planında `applies_when` eşleşir ve canonical kural referansı görünür. Full review ile lite/focused review farkı dokümante edilir. Kısa AGENTS kontrolünde de pahalı test gerekçesi görünür. Bu model davranışını kesinleştiren otomatik bir garanti olarak sunulmaz.

U6 başarılı olduktan sonra `ce-compound` çağrılır: olayın nedeni (katmanlar arasında aynı kanıtı tekrar kurmak), gerçek ölçümler, korunmuş sınırlar ve pack'e bağlantı kaydedilir. Pack kural metni learning dosyasında çoğaltılmaz. Test beklentisi: doküman/config keşif kontrolü; yeni pahalı integration matrisi yok.

## Verification Contract

Mevcut `bun run check`, `bun run test:integration`, ilgili dependency/lint/typecheck komutları doğruluk kapsamını korur. Geliştirmede yalnız değişen alt seviye testler ve ilişkili gerçek boundary çalıştırılır; mevcut hook gate'i geçtikten sonra aynı gate gerekçesiz tekrarlanmaz.

Kabul kanıtı birlikte sunulur: eski→yeni davranış eşlemesi; tam başarılı önce/sonra sonuçları; ortam ve cache koşulları; toplam wall ve dosya süreleri; setup/native invocation farkı; başarısızlık/skip bilgisi; korunan native matris. Farklı host veya farklı kapsamlı koşular tek yüzdeye indirgenmez.

Yeni ölçüm script'inin kendi mantığı unit düzeyinde doğrulanır; gerçek process exit aktarımı için bir küçük yerel smoke yeterlidir. Bu optimizasyonun kendisi yeni çok dakikalık test paketi üretmemeli.

## Definition of Done

- R1–R10 ve AE1–AE5 karşılanmış; bütün eski kanıtlar retained veya named replacement ile eşlenmiş.
- Bütün gerekli kontroller yeşil; strict ayar/özellik/manager desteği daralmamış.
- KTD6 hedefi karşılaştırılabilir ölçümle karşılanmış veya açıkça karşılanmadığı raporlanmış; ikincisi performans işinin tamamlandığı anlamına gelmez.
- Fixture paylaşımı mutable state'i taşımıyor; cold run aynı kanıtı çalıştırıyor.
- Pack gerçekten keşfediliyor; AGENTS fallback ve ölçüm yolu mevcut; doğrulanmış öğrenim canonical kuralı işaret ediyor.
- README komutları gerçek kapsamla tutarlı; mevcut staged işler korunmuş.
- Commit/push/PR bu planın otomatik sonucu değil; yayın kullanıcı kararı.

## Açık noktalar ve yapılmayanlar

Implementasyona başlamayı engelleyen ürün sorusu yok. 300 saniye/%60 hedefi öneridir; plan onayıyla kabul hedefi olur, elde edilmiş sonuç sayılmaz. Gerçek CI runner seçimi bu işten sonraki CI kurulumuna aittir. Güvenli fixture paylaşımının hangi dosyada ne kadar kazandırdığı U1 ölçümüyle belirlenir; karar boşluğu olarak bırakılan ürün davranışı yoktur.

Testleri nightly'ye kaçırmak, her manager'a bütün framework matrisini uygulamak, bütün native testleri mock'lamak, sırf oran düzeltmek için FS testlerini unit diye adlandırmak ve ilk çözüm olarak daha fazla CI worker almak değerlendirildi ve bu kapsamda seçilmedi.

## Appendix

### Dosya bazında geçiş tablosu

Aşağıdaki teknik tablo planlama sırasında kaynak dosyalar okunarak çıkarıldı. **U:** saf unit; **L:** yerel gerçek etkileşim; **N:** gerçek native araç. Satırlar dosyanın tek parça taşınmasını değil, içindeki kanıtların ayrılmasını belirtir. Her testin isim bazında nihai eşlemesi U1'in zorunlu çıktısıdır.

| File | Seconds | Disposition and exact replacement/evidence |
|---|---:|---|
| `config.test.ts` |0.02|Keep L atomic flush, concurrent startup, invalid/symlink never overwritten, metadata/content races. Default/override/independent-hash permutations belong to existing `tests/unit/config/{inspection,lint,typecheck}.test.ts`; keep one load→flush→reread integration spanning all sections, not three copies of the same default matrix. |
| `discovery.test.ts` |0.08|Keep L real root/nested manifests, pruning/symlink boundaries, workspace discovery and stable IDs. Manifest-manager precedence and relationship ambiguity permutations can become U in new `tests/unit/inspect/{manifest,relationships}.test.ts` using parsed documents/records; retain one real fixture per native workspace declaration form. This is low runtime priority. |
| `performance.test.ts` |0.35|Keep L bounded scanner IO, excluded dependency trees and real watcher subscription counts. These assert algorithmic work, not a wall-clock SLA; don't delete as 'performance-only' or replace with mocked scanner. |
| `packaging/processes.test.ts` |0.07|Keep L two real processes publishing complete independent snapshots; a unit cannot establish publication/process isolation. |
| `packaging/structure.test.ts` |0.18|Keep L getter/cache/refresh/publication and actual watcher boundaries. Immutable result-shape calculations may be U if independently extracted; no need to refactor cheap synchronization tests merely to reduce counts. |
| `packaging/metadata.test.ts` |0.01|Keep L equal-size/preserved-mtime config edit. Metadata-change predicate can be U once pure; retain one native-event/getter invalidation bridge. |
| `packaging/lifecycle.test.ts` |0.22|Keep L shared refresh, per-waiter cancellation, publication unwinding, shutdown and watcher fallback. These already use controlled local seams; do not relabel as unit. |
| `lint/projection.test.ts` |0.03|Split. U: `Python projection preserves unrelated bytes...`, ambiguous inline-container rejection, forbidden project-local options, root-policy merge, JS/Go rendering decisions. Put in `tests/unit/lint/projection.test.ts`, calling existing projection render functions. L: actual source discovery, child/symlink exclusions, file-ownership marker, stale-before-write/CAS and dependency directories. |
| `lint/javascript.test.ts` |138.52|Split pure config/compatibility/resolver cases into `tests/unit/lint/{javascript-policy,javascript-versions}.test.ts`. Keep N one install+minimal lint/format check per supported manager. Current second five-manager loop repeats full typed TS/React hooks/a11y/Next/project-service/native-optout matrix: retain comprehensive framework policy proof on npm, and a PnP resolution-specific typed/plugin proof on modern Yarn. For pnpm,Classic,Bun keep minimal actual installed/plugin invocation proof; reuse their already prepared manager fixture rather than repeat full Next application install. Keep pnpm nonstandard layout in outcomes. No manager silently dropped. |
| `lint/javascript-outcomes.test.ts` |26.31|Split N actual ESLint config precedence/import-sort/typed rules and pnpm custom modules/store/lock path into compact installed-tool scenarios. U parser/status permutations: cancelled/truncated/empty/crash inputs in `tests/unit/lint/javascript-outcomes.test.ts`; L real missing binaries/damaged environment and global no-network guard. Keep one bounded-output real-process proof in runner; do not generate2000ESLint violations only to prove the status mapping. Keep literal `[a]` exclusion one actual ESLint glob bridge; pure glob escaping permutations U. Actual install-failure-effects native test stays because metadata after real npm failure is a native contract. |
| `lint/python.test.ts` |12.43|Split U conflicting declaration/source/group predicates, PyPI stable/yanked selection, parser/outcome matrices into `tests/unit/lint/{python-preflight,python-versions,python-outcomes}.test.ts`. Keep N uv+Ruff install/workspace pin reconciliation, environment interpreter selection, strict+format/config authority, first-party import handling, selected paths and native partial effects. Combine successive source mutations on one installed immutable-tool fixture, with fresh source/config roots where paths allow. Source/src-layout is genuine Ruff resolution behavior; keep both inside one native scenario. |
| `lint/go.test.ts` |19.86|U policy malformed-option and stable version/platform selection permutations. L archive checksum/interrupted stream/path validation, corrupted/missing binary, process cancellation/truncation, publication guarantees. N actual golangci rule/format output, go.work scope, readonly workspace/checksum handling and binary build-Go compatibility. Keep one actual external runner lock contention scenario (6.27s) because native golangci locking semantics are not unit-proven; measure whether controllable synchronization can remove the wait without altering its meaning. |
| `lint/mixed-repository.test.ts` |25.15|Keep one N full shared policy/selected-check/cross-ecosystem scenario, but reuse the run-scoped tool payloads from language suites instead of fresh public installs. Move empty-root/unsupported-manager selection to L (or U target-selection boundary) rather than use mixed native fixture. Avoid repeating each language's lint rule catalogue here; assert wiring/scope/state only. |
| `lint/cli.test.ts` |3.35|Keep one N API/CLI parity and readonly check. U result/exit mapping and cancellation-after-check preservation via production-used result builder; L CLI argv/process serialization + unprepared/no-writes and queue policy revalidation. Do not reinstall Ruff for every result-state variation. |
| `lint/lifecycle.test.ts` |0.24|Keep L fake adapter with real inspection/state/watcher orchestration: version-wave restart, pending discovery, config self-writes, failed wave. Pure wave transition tables can move U if planner reducer is extracted for production reuse, but no runtime payoff justifies broad coordinator rewrite. |
| `lint/provisioning.test.ts` |0.16|Keep L no setup from getter/empty folder, state recovery, retained ownership, unresolved managers. It already avoids native package install; don't move it into an expensive native lane. Consolidate exact duplicate ownership assertion with lifecycle only after named coverage mapping. |
| `lint/concurrency.test.ts` |0.39|Keep L real lease ordering, controlled subprocess shutdown, watcher cleanup and stopped-instance ownership; no public registry dependency. Preserve barriers rather than timing-based sleeps. Pure failure-to-result mapping variants move U. |
| `dependencies/inventory.test.ts` |0.00|Currently L: writes manifest, inspects project, reads inventory. Extract/use production-owned parsed-manifest→inventory logic for U JS groups/Python extras+markers/Go indirect/source variants in `tests/unit/dependencies/inventory.test.ts`; retain one filesystem reader bridge for JSON/TOML/go.mod. Do not call current cases pure just because no package installation occurs. |
| `dependencies/executable.test.ts` |0.03|Currently probes actual uv. Move PEP440 `!=`, `~=`, bound combinations to U against production-used `uvRequirement` helper in a version-requirements module. Retain one N uv version probe→requirement enforcement integration; exact installed version must be fixture input, not hidden host assumption. |
| `dependencies/npm-lock-order.test.ts` |0.00|Split U manifest↔lock declaration equality (reordered/changed/missing/extra) in existing `tests/unit/dependencies/adapters/npm.test.ts` or production-owned lock helper; retain one L lockfile inventory bridge ensuring npm is not invoked. Existing native npm lifecycle covers real lock generation. |
| `dependencies/pnpm-config.test.ts` |14.68|U literal config key/env-expansion/precedence predicates only; L canonical/symlink destination/root-boundary and shared-domain tests; N one actual lifecycle for each `.npmrc`/workspace YAML supported configuration source, custom store/modules/lock path and native effective-config agreement. These two configuration entrypoints are a native distinction, not duplicate happy paths. |
| `dependencies/service.test.ts` |0.64|U alias normalization, forbidden repository shorthand, partial-semver input rejection and response assembly. Keep L fresh inspection selection and no-write rejection. Keep native two-step removal→install failure effects, preferably use existing manager/npm native scenario as behavior source and service test with controlled process for propagation; don't prove identical npm failure twice unless wrapper effects differ. |
| `dependencies/domains.test.ts` |1.83|Keep L canonical shared write domains, real controlled processes, symlink aliases, requeue after environment change; no package fetch. Independent queue waiter permutations can be U async queue tests, but don't remove real shutdown/lease boundary checks. |
| `dependencies/runner.test.ts` |0.50|Keep L real child/grandchild cancellation, bounded stdout/stderr, nonzero exit, lease release after process close. This is canonical actual process-boundary evidence; language suites test how they interpret ProcessResult in U. |
| `dependencies/outcomes.test.ts` |0.69|U redact strings/structured values and outcome classification in `tests/unit/dependencies/outcomes.test.ts`; keep one L/N real npm metadata mutation containing credentials to verify persistence is unchanged while public result is redacted. Keep cancellation propagation with a controlled local process. |
| `dependencies/source-boundaries.test.ts` |0.11|U protocol parsing, PEP508 semicolon handling, inherited source-base derivation; keep L actual in/out-root symlink/canonical path boundaries for each native declaration source. Cheap and protective; no broad deletion. |
| `dependencies/managers/npm.test.ts` |8.20|Keep N manager lifecycle, group/source/native lock semantics from shared case generator, plus real failed install retaining prior declaration removal. Pure args/rejection combinations already in unit adapters; avoid duplicating there. npm is6tests in log, not7 (summary duplicate trap). |
| `dependencies/managers/pnpm.test.ts` |6.78|Keep N same declared operations because pnpm flags/lock semantics differ. Shared case code is useful; don't treat multi-manager proof as automatically duplicate. Collapse purely shared postcondition permutations to unit adapter cases while native operation sequence remains. |
| `dependencies/managers/yarn-classic.test.ts` |16.34|Keep N native registry/Git/group/workspace/frozen-lock behavior. Use shared immutable package archive bytes and isolated loopback registry per case; group sequence may reuse same installed fixture serially with explicit reset, not parallel mutations. |
| `dependencies/managers/yarn-modern.test.ts` |25.52|Keep N PnP and node_modules linker resolution distinction, shared lock affected-project reporting, Git/group/workspace native semantics. PnP cannot inherit proof from npm/Classic. Reduce repeated per-case archive construction and manager bootstraps, not linker coverage. |
| `dependencies/managers/bun.test.ts` |1.23|Keep N actual Bun native semantics including binary lock inventory/frozen sync. Already cheap; avoid rewriting to optimize test counts. |
| `dependencies/managers/uv.test.ts` |10.38|Keep N resolver/normalization/marker/extras/workspace/source group semantics and installed version; U unsupported inputs/selection and parsed declaration equality are covered in unit adapter. Keep groups requiring distinct native flags verified, possibly within one serial lifecycle to amortize environment. No copying relocatable-assumed `.venv` directories. |
| `dependencies/managers/go.test.ts` |1.91|Keep N local module/proxy registry/ref query, workspace replacement and cold-cache readonly behavior. Move unsupported group/runtime-name/arbitrary-URL rejection and declarative override-predicate permutations to U adapters; keep actual go.work override interaction witnesses. |
| `dependencies/managers/js-review.test.ts` |5.94|Keep one N actual override-blocked exact update and native v-prefixed normalization per affected manager because native solvers differ; common selector validation U. Keep modern Yarn mixed registry/Git/local update as distinct manager behavior. |
| `dependencies/managers/npm-pnpm-version.test.ts` |0.35|Keep L/N fixture launcher version mismatch check; tiny and protects truthful native evidence. Don't count it as product test savings. |
| `omp/extension.test.ts` |0.70|Keep L real OMP loader/tool schemas/session events, denial and watcher shutdown. Cheap actual host boundary, no full language install. Schema permutation matrices can U tool schema definitions; retain real host rejection sample. |
| `omp/dependencies.test.ts` |5.23|Keep one N OMP→npm lifecycle and L true host denial/session/root-switch/native child join + queued call. U response shaping/errors schema permutations. Share test fixture builders with OMP lint/typecheck, not global mutable sessions. |
| `omp/lint.test.ts` |12.97|Keep N one Ruff tool/API parity smoke; L real OMP startup/new-manifest/root-switch/shutdown/control-process cases with fake adapter/controlled installer rather than real Ruff package install on every ownership scenario. Keep at least one actual startup→native prepare→tool bridge. Schema/unknown-ID variations U or L no-native. |
| `omp/installed-smoke.test.ts` |54.50|Keep ONE actual packed-and-installed extension proof: outside-checkout resolution, exported API/bin/docs/formatter.cjs, real OMP registration and representative lint/typecheck invocation. Already one shared installation; don't add duplicate installed package tests elsewhere. Move detailed rule/outcome matrices to source-level unit/native suites. Warm package-download cache keyed by exact payload, but installed consumer root remains fresh and independent of source checkout. Another worker may refine typecheck-specific repeated calls. |

| Existing file | Keep real proof | Move / consolidate and replacement |
| --- | --- | --- |
| `tests/integration/typecheck/provisioning.test.ts` | Keep local integration for persisted wave restart, pending IDs, deleted/unresolved members, manager owner cohorts and lint receipt handover. Uses real inspection/state plus injected `TypecheckAdapter`, no native installer. | No expensive native setup to remove. Pure version comparisons can use existing `src/typecheck/versions.ts` in `tests/unit/typecheck/versions.test.ts`; do not duplicate the entire wave algorithm in a fake or extract it just for the0.23s suite. |
| `tests/integration/typecheck/lifecycle.test.ts` | Keep all three local integrations: readonly getter, ecosystem isolation, session sharing/root switching. | Use these as the home for lifecycle permutations currently paying for Pyright in OMP/service tests. Keep one host-to-coordinator wiring check separately. |
| `tests/integration/typecheck/concurrency.test.ts` | Keep real queue/domain waits, filesystem changes, subscriptions and the actual local child that acknowledges SIGTERM before lease release. No registry/native compiler needed. | Consolidate generic cancellation/last-owner permutations here from native OMP tests; host root-change wiring remains a separate cheap boundary test. No label-only unit conversion. |
| `tests/integration/typecheck/python.test.ts` | Keep native source+test strict policy/import precedence, two actual uv owner environments and missing stubs, and one workspace exact upgrade/partial-effect proof. These rely on Pyright/uv behavior. | PyPI stable/non-yanked choice and503 error identity -> unit with supplied registry response (`versions.test.ts`). Declaration group/source rejection -> unit of declaration planning, with no uv invocation. Malformed/summary mismatch/crash/truncated output permutations -> unit parser/result classifier (`diagnostics.test.ts`, `outcomes.test.ts`). Keep one installed-checker missing/no-bootstrap boundary. Missing Node/Python preflight can be local executable-contract tests, not full successful setup. Config JSONC/TOML/default/override transformations -> unit/local-file projection tests (`projections.test.ts`); keep one actual Pyright policy sentinel that combines representative strict errors. |
| `tests/integration/typecheck/javascript.test.ts` | Keep one exact install/upgrade lifecycle for EACH npm/pnpm/Yarn Classic/modern Yarn/Bun; real installed compiler execution validates package/binary/PnP resolution. Keep actual TS5 PnP success + TS7 incompatibility and old Yarn4.12 patch failure, because these are proven manager-specific. Keep native config semantics anchors for aliases/app-test contexts, JS/TSX strict coverage, and imported-child ownership. | Do not run common semantic/error matrix across all managers. Runtime metadata/overrides/group rejection -> unit plan validation. Parser/truncation/crash mapping -> unit outcomes; one real process truncation test belongs in runner boundary suite. Package JSONC syntax/context assignment already has `tests/unit/typecheck/config-graph.test.ts`; extend there. Native missing-reference output remains one compiler proof; outside/cycle/path permutations -> pure graph validation or local-file integration without package install. |
| `tests/integration/typecheck/references.test.ts` | Keep native topological declaration generation, deleted-output regeneration (native incremental shortcut previously skipped it), same-package reference semantics, and mixed-JS/native allowJs:false declaration output reconciliation (real TS output diverged from earlier assumptions). Keep local package resolution without explicit TS references. | Topological/cycle/ambiguous/outside-root/output-collision permutations -> unit graph/plan helpers or local-file tests with semantic compiler metadata inputs, validated by retained native anchors. Final readiness failure retaining completed result -> unit result assembly + local state integration, not a new npm install. Merge the same chain fixtures rather than rerunning full setup per bookkeeping assertion. A source-change->repair and missing-output->repair lifecycle is justified once; do not repeat at API and Next layers. |
| `tests/integration/typecheck/next.test.ts` | Native route typegen/validator, custom config and output paths, dynamic extra dependency closure revealed by config, compiler metadata side effects, actual async config cancellation, and unsupported Next15 command shape are real framework boundaries. | Replace the duplicated full default/custom lifecycle with one simple default sentinel and one custom-path/local-chain lifecycle. Use public API for one retained Next scenario to subsume `service.test.ts` Next happy/stale/repair duplicate. Config error/result shapes -> unit classifier; check-only-not-executing-config remains real config-run counter. Native side-effect/cancellation cases should start from isolated prepared baseline without reinstalling framework packages for each assertion. Avoid f.project/readiness preparation repeated when no relevant source/config changed, but never remove production revalidation to speed tests. |
| `tests/integration/typecheck/service.test.ts` | Keep selected identity-before-write/read-only behavior as local integration; one public end-to-end prepare/check truthfulness proof, and shared-owner source mutation as local integration. | `late cancellation retains completed diagnostics`, `truncated native diagnostics`, unrelated ecosystem error aggregation -> unit result composition using known adapter outcomes; preserve one wiring sentinel. Required-local-source late mutation -> local integration with deterministic adapter operation that writes file, not another real TS chain. Public Next check -> covered by retained Next test invoked through public API. Public Go check -> run retained Go sentinel via public API. Corrupt-state schema variants -> unit state parser; one local persistence recovery scenario uses injected adapter and verifies revalidation/read-only bytes, no Pyright reinstall needed. |
| `tests/integration/typecheck/go.test.ts` | Keep source/internal/external tests, no-execution init/TestMain/test sentinels, module/workspace and checksum preservation, build tags/platform selection, real child cancellation/cleanup. These are cheap and guard compiler/OS behavior. | Diagnostic text containing runtime failure words, deepest same-ecosystem owner selection, and failing-then-clean exit accumulation -> unit diagnostic/result aggregation. Move synthetic2200-missing-import truncation to generic runner byte-limit test plus Go classifier unit; retain meaningful actual missing module/CGo/toolchain preflight anchors. Do not spend refactor effort chasing total3.37s before JS hotspots. |
| `tests/integration/typecheck/cli.test.ts` | Keep real spawned CLI argument/JSON/exit integration and actual SIGTERM child-join proof. | Exit-code truth table and argument permutations -> unit parser/CLI mapper if a production-level internal boundary is extracted. Reuse prepared Python fixture or use installed-package CLI sentinel for success; do not run native clean+bad repeatedly solely to verify 0/1/2 mapping. Cancellation remains local subprocess integration, not mock-only. |
| `tests/integration/typecheck/mixed-repository.test.ts` | Keep one cross-feature native smoke: successful TS5 typed lint -> TS7 typecheck upgrade -> invalidated lint receipt/no downgrade, plus mixed target selection. This is the sole proof of actual lint/typecheck compatibility interaction. | Repeated loops checking all3 ecosystems clean twice and every diagnostic/error/readonly permutation duplicate language/service/lifecycle coverage. Keep one representative cross-feature check; move permutations to cheap local integrations. Existing invalidated-receipt fake-adapter test is not a replacement for actual installed compiler compatibility evidence. |
| `tests/integration/typecheck/local-packages.test.ts` | Keep real configless `.d.ts` and JSON-only shared config resolution; these were actual bugs. Include erroneous declaration diagnostic attribution. | A single app can extend local JSON config and import local `.d.ts` package in one clean fixture; distinct assertions preserve both obligations. Follow with erroneous declaration in the same explicit lifecycle, no second installation. Pure `packageOutputs` shapes -> unit plan helper. |
| `tests/integration/omp/typecheck.test.ts` | Keep actual host registration/approval/schema contract, one host invocation with content/details/API parity, startup/new-manifest handoff, and one real shutdown/root-change process join per distinct host boundary. | Full Pyright setup is unnecessary for schema denial/unknown IDs, prior-job effect ownership, second waiter lifetime, no-install getter and policy flush permutations. Use injected adapter/coordinator at the host service boundary while retaining actual OMP runner; these remain local integrations, not unit tests. Generic shared-owner permutations already have `concurrency.test.ts` and `lifecycle.test.ts` replacements. |

### Sources & References

- Mevcut `package.json`, `tests/integration/**`, `tests/unit/**` ve ilgili `src/{typecheck,lint,dependencies,packaging}` modülleri (2026-10-29 çalışma ağacı).
- `.compound-engineering/artifacts/plans/2026-10-29-1655-feat-project-typecheck-plan.md` ve `2026-10-29-0259-feat-shared-project-lint-plan.md`: korunacak ürün sözleşmeleri.
- Tarihsel tam koşu: `/private/tmp/justomp-typecheck-full-integration.log`; düzeltilmiş references senaryosu: `/private/tmp/justomp-reference-expectation-green.log`; yeni regresyonlar: `/private/tmp/justomp-typecheck-review-regressions.log`. Geçici loglar yok olursa bu belgedeki özet tarihsel veri olarak kalır; gerçek kabul için U1/U6 ölçümleri yeniden üretilir.
- Kurulu Compound Engineering 3.30.4: `docs/guides/packs.md`, `CONCEPTS.md`, `skills/ce-code-review/references/modes-and-output.md`, `skills/ce-compound/SKILL.md`. Pack aktivasyonu ve full/lite ayrımı bu sürümden doğrulandı.
- [Bun test reporters](https://bun.sh/docs/test/reporters): JUnit çıktı desteği; kurulu sürüm desteği U6'da doğrulanacak.

Planlama sırasında kaynak kod, test, package config veya aktif pack değiştirilmedi. Bu belge gelecekte yapılacak işleri tanımlar.
