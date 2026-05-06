# SistemasDistribuidosTALLER4

# 🚀 Proyecto Final - Parte I: Identidad
**Asignatura:** Sistemas Distribuidos  
**Institución:** Universidad de Boyacá  

Este repositorio contiene la implementación del **Servicio de Autenticación**, el primer componente del proyecto final: un videojuego multijugador distribuido.

---

## 🛠️ Arquitectura del Servicio
El **Auth-Service** es el núcleo de identidad del sistema. Se encarga de la gestión de usuarios y la generación de credenciales seguras.



### Componentes Técnicos:
* **Backend:** Node.js con Express.
* **Base de Datos:** SQLite (`better-sqlite3`) para persistencia local.
* **Seguridad:** Hasheo de contraseñas con `bcrypt` (10 rounds).
* **Autorización:** Emisión de tokens **JWT** (JSON Web Tokens) con expiración configurable.
* **Exposición:** Túnel HTTP mediante **Ngrok**.

---

## 📂 Estructura del Proyecto
```text
taller1-auth/
├── auth-service/
│   ├── users.db          # Base de datos (Ignorada en Git)
│   ├── .env              # Variables sensibles (Ignorada en Git)
│   ├── .env.example      # Guía para configuración de equipo
│   ├── index.js          # Lógica principal del servidor
│   └── package.json      # Dependencias
├── .gitignore            # Configuración de exclusión de archivos
└── README.md             # Documentación del proyecto