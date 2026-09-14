# First National Bank — Banking Platform Monorepo

Unified monorepo housing both the web/API backend banking portal and the companion native Android mobile application.

```
banking-demo/
├── package.json              # Monorepo orchestration scripts
├── web/                      # Express.js API Gateway, Microservices Mesh & Corporate Web Portal
└── mobile/                   # Native Android Companion App (Kotlin 2.2 / Jetpack Compose)
```

---

## Structure & Projects

### 🌐 [web/](./web) — Web Banking & API Microservices Mesh
The core corporate banking portal and backend microservices mesh:
- **Port 3000**: Unified API Gateway, reverse proxy & security layer
- **Microservices**:
  - Auth & Identity Service (`/api/v1/auth`)
  - Document & Base64 Vault Service (`/api/v1/documents`)
  - Corporate Onboarding Service (`/api/v1/applications`)
  - Live Core Banking & FX Service (`/api/v1/banking` & `/api/v1/mobile`)
  - Notification & Mailbox Service (`/api/v1/notifications`)
  - RM Executive Portal & Pipeline Service (`/api/v1/rm`)

#### Quick Start (Web):
```bash
# From monorepo root:
npm start
# Or specifically:
npm run start:web

# Or directly in web/ directory:
cd web
npm start
```

---

### 📱 [mobile/](./mobile) — Native Android Application
Native Android application providing client onboarding, multi-currency corporate treasury hub, and RM executive suite.
- **Platform**: Android SDK 36 (minSdk 24)
- **Language**: Kotlin 2.2
- **UI Framework**: Jetpack Compose (Material Design 3)
- **Build System**: Gradle 9.3.1 with Android Gradle Plugin 9.1.1

#### Quick Start (Mobile):
Open the `mobile/` directory or root project in Android Studio, or build with:
```bash
cd mobile
./gradlew assembleDebug
```
