module.exports = {
  apps: [
    {
      name: 'senddrive',
      script: './server/index.js',
      cwd: '/var/www/senddrive',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/var/log/senddrive/error.log',
      out_file: '/var/log/senddrive/out.log',
      merge_logs: true,
    },
  ],
};
