module.exports = {
  apps: [
    {
      name: "meridian",
      script: "index.js",
      cwd: __dirname,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
        DRY_RUN: "true",
        // PNL_DASHBOARD_RESET: fresh $50 sim wallet. 0.6098 SOL @ ~$82 ≈ $50.00.
        SIMULATED_SOL_BALANCE: "0.6098",
      },
    },
  ],
};
