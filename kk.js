// The staff app has moved to Cloudflare. This sends old links and bookmarks to the same page at the new address.
location.replace('https://kk-staff.kk-staff-server.workers.dev/' + (location.pathname.split('/').pop() || 'index.html') + location.search);
