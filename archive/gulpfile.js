(() => {
  var gulp = require("gulp");
  var minifyCSS = require("gulp-csso");
  var concat = require("gulp-concat");
  var uglify = require("gulp-uglify");
  var htmlmin = require("gulp-htmlmin");
  var minify = require("gulp-minify");
  var ngAnnotate = require("gulp-ng-annotate");
  var versionNumber = require('gulp-version-number');
  var javascriptObfuscator = require("gulp-javascript-obfuscator");
  var minifyInline = require("gulp-minify-inline");

  // let client_folder = 'client';
  // let build_folder = 'build';

  let client_folder = 'client_wc';
  let build_folder = 'build_wc';

  // let client_folder = 'client';
  // let build_folder = 'build';

  let JS_Files = [
    client_folder + "/js/util.js",
    client_folder + "/js/services/KiteTicker.js",
    client_folder + "/js/app.js",
    client_folder + "/js/services/ticker.js",
    client_folder + "/js/services/socket.js",
    client_folder + "/js/services/fixedCol.js",
    client_folder + "/js/controllers/common.js",
    // client_folder + "/js/controllers/builderCtrl.js",
    client_folder + "/js/controllers/paper.js",
    client_folder + "/js/controllers/adminCtrl.js",
    client_folder + "/js/controllers/usersCtrl.js",
  ];

  const versionConfig = {
    'value': '%MDS%',
    'append': {
      'key': 'v',
      'to': ['css', 'js'],
    },
  };

  var vendor_files = {
    js: [
      client_folder + "/js/jquery/jquery.min.js",
      client_folder + "/js/bootstrap/bootstrap.bundle.min.js",
      client_folder + "/vendor/angular.js",
      client_folder + "/vendor/angular-resource.js",
      client_folder + "/vendor/angular-ui-router.js",
      client_folder + "/vendor/loading-bar.min.js",
      client_folder + "/vendor/moment.js",
      client_folder + "/vendor/socket.io.js",
      client_folder + "/js/charts.js",
      client_folder + "/js/html2canvas.js",
      client_folder + "/js/filesaver.js",
    ],
    css: [
      client_folder + "/css/fontawesome/css/all.min.css",
      client_folder + "/css/adminlte/adminlte.min.css",
      // client_folder + "/vendor/angular-loading-bar/build/loading-bar.min.css"
    ],
    fonts: [
      // "client/vendor/Ionicons/fonts/*.*",
      client_folder + "/vendor/bootstrap/fonts/*.*",
      // "client/vendor/font-awesome/fonts/*.*"
    ]
  };

  function lbServices() {
    return gulp
      .src([client_folder + "/js/services/lb-services.js"])
      .pipe(concat("lb-services.js"))
      .pipe(
        minify({
          mangle: false,
          ext: {
            min: ".js"
          },
          noSource: true
        })
      )
      .pipe(gulp.dest(build_folder + "/assets"));
  }

  function html() {
    return (
      gulp
        .src([client_folder + "/views/*/*.html", client_folder + "/views/*.html"])
        // .pipe(htmlmin({ collapseWhitespace: true }))
        .pipe(gulp.dest(build_folder + "/views"))
    );
  }

  function main_html() {
    return gulp
      .src(client_folder + "/build.html")
      .pipe(concat("index.html"))
      .pipe(htmlmin({
        collapseWhitespace: true
      }))
      .pipe(minifyInline())
      .pipe(versionNumber(versionConfig))
      .pipe(gulp.dest(build_folder));
  };

  function css() {
    return gulp
      .src(client_folder + "/css/*.css")
      .pipe(concat("vendor-styles.css"))
      .pipe(minifyCSS())
      .pipe(gulp.dest(build_folder + "/assets"));
  };

  function js() {
    return gulp
      .src(JS_Files)
      .pipe(concat("app.min.js"))
      .pipe(ngAnnotate())
      .pipe(
        minify({
          mangle: true,
          ext: {
            min: ".js"
          },
          noSource: true
        })
      )
      .pipe(
        javascriptObfuscator({
          compact: true,
          deadCodeInjection: false,
          // deadCodeInjectionThreshold: 0.5,
          // debugProtection: true,
          // debugProtectionInterval: true,
          identifierNamesGenerator: "hexadecimal",
          // rotateStringArray: true,
          selfDefending: true,
          // stringArray: true,
          target: "browser"
        })
      )
      .pipe(gulp.dest(build_folder + "/assets"));
  };

  function vendor_css() {
    return gulp
      .src(vendor_files.css)
      .pipe(minifyCSS())
      .pipe(concat("vendor.min.css"))
      .pipe(gulp.dest(build_folder + "/assets"));
  };

  function vendor_js() {
    return gulp
      .src(vendor_files.js)
      .pipe(concat("vendor.min.js"))
      .pipe(
        minify({
          mangle: true,
          ext: {
            min: ".js"
          },
          noSource: true
        })
      )
      .pipe(gulp.dest(build_folder + "/assets"));
  }

  // exports.default = gulp.series(lbServices, css, html, main_html, js, vendor_css, vendor_js);
  exports.default = gulp.series(lbServices, html, main_html, js);
  // exports.default = gulp.series(main_html);
  // exports.default = gulp.series(vendor_js);
})()
