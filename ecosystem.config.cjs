module.exports = {
  apps: [
    {
      name: "telecode-bridge",
      script: "src/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 100,
      restart_delay: 3000,
      max_memory_restart: "400M",
      time: true,
      out_file: "logs/out.log",
      error_file: "logs/err.log",
      env: { NODE_ENV: "production" }
    }
  ]
};
