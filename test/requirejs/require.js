(function(
  userConfig, 
  defaultConfig, 
  hasMap, 
  has
) {
  //
  // This function defines the backdraft JavaScript script-inject loader--an AMD-compliant 
  // (http://wiki.commonjs.org/wiki/Modules/AsynchronousDefinition), requirejs-compatible 
  // (http://requirejs.org/) loader. 
  // 
  // This loader exists under a separate project named bdLoad.
  // 
  // For a complete tutorial on the use of this loader, see xxx
  // The loader may be run-time configured with several configuration variables; see xxx.
  // The loader may be run-time and/or build-time configured with has.js switches; see xxx.
  // 
  // In addition to AMD-compliance and requirejs-compatibility, the loader has the following
  // features:
  // 
  //  * It is highly configurable. The has.js interface is used for both run-time and build-time
  //    configuration. The default implementation assumes a full feature set for the browser. 
  //    However, this can be changed quite dramatically by providing a has.js implementation
  //    and configuration prior to entry. For example, by providing alternate inject functions 
  //    and a has.js configuration that detects a non-brow  ser environment (e.g., V8), the loader
  //    is made available to a wide variety of non-browser environments.
  // 
  //  * The features mentioned above are useful in constructing highly optimized release
  //    packaging. For example, it is possible to remove all dynamic script-injecting and receiving
  //    so that an entire application can be bundled into a single file.
  // 
  //  * Generalized error detection and reporting, configurable tracing, and descriptive object 
  //    state variables are included to help find and solve programming errors, with special
  //    emphasis on loading errors.
  // 
  // Since this machinery implements a loader, it does not have the luxury of using a load system
  // to divide the implementation among several resources. This results in an unpleasantly long file.
  // Here is a roadmap of the contents:
  // 
  //   1. Optional, trivial, naive has.js if real has.js was not provided
  //   2. Small library for use implementing the loader
  //   3. Once-only protection.
  //   4. Define global AMD define and require functions.
  //   5. Define configuration machinery and configure the loader
  //   6. Core loader machinery that instantiates modules as given by factories and dependencies.
  //   7. Machinery to request, receive, and process module definions.
  //   8. Browser-based machinery--for use when the loader is used in a browser
  //   9  DOM content loaded detection machinery
  //  10. Trace, error detection, and miscellaneous other optional machinery.
  // 
  // Language and Acronyms and Idioms
  // 
  // moduleId: a CJS module identifier, (used for public APIs)
  // mid: moduleId (used internally)
  // packageId: a package identifier (used for public APIs)
  // pid: packageId (used internally); the implied system or default package has pid===""
  // context-qualified name: a mid qualified by the pid of which the module is a member; result is the string pid + "*" + mid
  // pqn: package-qualified name
  // pack: package is used internally to reference a package object (since lame JavaScript has reserved words including "package")
  // The integer constant 1 is used in place of true and 0 in place of false.
 
  // if has is not provided, define a trivial implementation
  if (!has) {
    has= function(name) { 
      return hasMap[name]; 
    };
  }

  var
    // define a minimal library to help build the loader

    noop= function() {
    },

    isEmpty= function(it) {
      for (var p in it) return false;
      return true;
    },
    
    isFunction= function(it) {
      return (typeof it=="function");
    },
    
    isString= function(it) {
      return (typeof it=="string");
    },

    isArray= function(it) {
      return (it instanceof Array);
    },

    forEach= function(vector, callback) {
      for (var i= 0; vector && i<vector.length;) callback(vector[i++]);
    },

    setIns= function(set, name) {
      set[name]= 1;
    },

    setDel= function(set, name) {
      delete set[name];
    },

    mix= function(dest, src) {
      for (var p in src) dest[p]= src[p];
      return dest;
    },

    uidSeed= 
      1,

    uid= 
      function() {
        ///
        // Returns a unique indentifier (within the lifetime of the document) of the form /_d+/.
        return "_" + uidSeed++; 
      },

    // the loader will use these like symbols
    requested= {},
    arrived= {},
    nonmodule= {},

    //bring in the backdraft documentation generating machinery (stripped during builds)
    bd= {
      docGen: 
        // Documentation generator hook; facilitates generating documentation for named entities that have 
        // no place in normal JavaScript code such as keyword arguments, overload function signatures, and types.
        // 
        // bd.docGen has no actual run-time function; if called it simply execute a no-op. All bd.doc
        // calls are removed by the Backdraft build utility (and/or other intelligent compilers) for
        // release versions of the code.  See the ALTOVISO js-proc manual for further details.
        noop
    };

  // the loader can be defined exactly once
  if (isFunction(userConfig)) {
    return;
  }

  //
  // Global Loader API
  // 
  // define and require make up the global, public API
  //
  var 
    injectDependencies= function(module) {
      forEach(module.deps, injectModule);
    },
  
    contextRequire= function(a1, a2, a3, referenceModule, contextRequire) {
      if (isString(a1)) {
        // signature is (moduleId)
        var module= modules[getModuleInfo(a1, referenceModule).pqn];
        return module && module.result;
      }
      if (!isArray(a1)) {
        // a1 is a configuration
        config(a1);

        // juggle args; (a2, a3) may be (dependencies, callback)
        a1= a2;
        a2= a3;
      }
      if (isArray(a1)) {
        // signature is (requestList [,callback])
        injectDependencies(defineModule(getModule(uid()), a1, a2 || noop));
        checkComplete();
      }
      return contextRequire;
    },

    createRequire= function(module) {
      var result= module.require;
      if (!result) {
        result= function(a1, a2, a3) {
          return contextRequire(a1, a2, a3, module, result);
        };
        result.nameToUrl= function(name, ext) {
          return nameToUrl(name, ext, module);
        };
        if (has("loader-undefApi")) {
          result.undef= function(moduleId) {
           // In order to reload a module, it must be undefined (this routine) and then re-requested.
           // This is useful for testing frameworks (at least).
             var 
               module= getModuleInfo(moduleId, module),
               pqn= module.pqn;
             setDel(modules, pqn);
             setDel(waiting, pqn);
             setDel(injectedUrls, module.url);
          };
        }
        module.require= mix(result, req);
      }
      return result;
    },

    def= function(
      mid,          //(commonjs.moduleId, optional) list of modules to be loaded before running factory
      dependencies, //(array of commonjs.moduleId, optional)
      factory       //(any)
    ) {
      ///
      // Advises the loader of a module factory. //Implements http://wiki.commonjs.org/wiki/Modules/AsynchronousDefinition.
      ///
      //note
      // CommonJS factory scan courtesy of James Burke at http://requirejs.org
  
      var 
        arity= arguments.length,
        args= 0,
        defaultDeps= ["require", "exports", "module"];
      if (has("loader-amdFactoryScan")) {
        if (arity==1) {
          dependencies= [];
          mid.toString()
            .replace(/(\/\*([\s\S]*?)\*\/|\/\/(.*)$)/mg, "")
            .replace(/require\(["']([\w\!\-_\.\/]+)["']\)/g, function (match, dep) {
              dependencies.push(dep);
            });
          args= [0, defaultDeps.concat(dependencies), mid];
        }
      }
      if (!args) {
        if (arity==3 && dependencies==0) {
          // immediate signature
          execModule(defineModule(getModule(mid), [], factory, 0));
          return;
        }
        args= arity==1 ? [0, defaultDeps, mid] :
                         (arity==2 ? (isArray(mid) ? [0, mid, dependencies] : [mid, defaultDeps, dependencies]) :
                                                     [mid, dependencies, factory]);
      }
      if (has("loader-traceApi")) {
        req.trace("loader-define", args.slice(0, 2));
      }
      defQ.push(args);
    },
  
    req= function(
      config,       //(object, optional) hash of configuration properties
      dependencies, //(array of commonjs.moduleId, optional) list of modules to be loaded before applying callback 
      callback      //(function, optional) lamda expression to apply to module values implied by dependencies
    ) {
      ///
      // Loads the modules given by dependencies, and then applies callback (if any) to the values of those modules. //The
      // values of the modules given in dependencies are passed as arguments.
      //
      // If config is provided, then adjust the loaders configuration as given by config hash before proceeding. 
      //
      //note
      // `require([], 0)` will cause the loader to check to see if it can execute more modules; this can be useful for build systems.
      bd.docGen("overload",
        function(
          moduleId //(commonjs.moduleId) the module identifier of which value to return
        ) {
          /// 
          // Return the module value for the module implied by `moduleId`. //If the implied
          // module has not been defined, then `undefined` is returned.
        }
      );
      return contextRequire(config, dependencies, callback, 0, req);
    };

  // now that we've defined the global require variable, we can start hanging properties off it it
  var
    pathTransforms=
      // list of functions from URL(string) to URL(string)
      [],

    paths=
      // requirejs paths
      {},

    pathsMapProg=
      // list of (from-path, to-path, regex, length) derived from paths;
      // a "program" to apply paths; see computeMapProg
      [],

    packages=
      // a map from packageId to package configuration object
      {},

    packageMap=
      // map from package name to local-installed package name
      {},

    packageMapProg=
      // list of (from-package, to-package, regex, length) derived from packageMap;
      // a "program" to apply paths; see computeMapProg
      [];

  // configure require
  var
    computeMapProg= function(map) {
      // This routine takes a map target-prefix(string)-->replacement(string) into a vector 
      // of quads (target-prefix, replacement, regex-for-target-prefix, length-of-target-prefix)
      // 
      // The loader contains processes that map one string prefix to another. These
      // are encountered when applying the requirejs paths configuration and when mapping
      // package names. We can make the mapping and any replacement easier and faster by
      // replacing the map with a vector of quads and then using this structure in simple machine.
      var p, i, item, mapProg= [];
      for (p in map) mapProg.push([p, map[p]]);
      mapProg.sort(function(lhs, rhs) { return rhs[0].length - lhs[0].length; });
      for (i= 0; i<mapProg.length;) {
        item= mapProg[i++];
        item[2]= new RegExp("^" + item[0] + "(\/|$)");
        item[3]= item[0].length + 1;
      }
      return mapProg;
    },

    fixupPackageInfo= function(packageInfo, baseUrl) {
      // calculate the precise (name, baseUrl, lib, main, mappings) for a package
      baseUrl= baseUrl || "";
      packageInfo= mix({lib:"lib", main:"main", pathTransforms:[]}, (isString(packageInfo) ? {name:packageInfo} : packageInfo));
      packageInfo.location= baseUrl + (packageInfo.location ? packageInfo.location : packageInfo.name);
      packageInfo.mapProg= computeMapProg(packageInfo.packageMap);
      var name= packageInfo.name;

      // now that we've got a fully-resolved package object, push it into the configuration
      packages[name]= packageInfo;
      packageMap[name]= name;
    },

    config= function(config, booting) {
      // mix config into require, but don't trash the pathTransforms
      var p, i, configUrlMap;

      if (has("loader-requirejsApi")) {
        config.deps && (config.load= config.deps);
        //note: bdLoad ignores requirejs waitSecond; change your code to use "timeout" if required
      }

      // push config into require, but don't step on certain properties that are expected and
      // require special processing; notice that client code can use config to hold client
      // configuration switches that have nothing to do with require
      for (p in config) if (!/pathTransforms|paths|packages|packageMap|packagePaths|hasValues|ready/.test(p)) {
        req[p]= config[p];
      };

      // interpret a pathTransforms as items that should be added to the end of the existing map
      for (configUrlMap= config.pathTransforms, i= 0; configUrlMap && i<configUrlMap.length; i++) {
        pathTransforms.push(configUrlMap[i]);
      }

      // push in any paths and recompute the internal pathmap
      pathsMapProg= computeMapProg(mix(paths, config.paths));

      // for each package found in any packages config item, augment the packages map owned by the loader
      forEach(config.packages, fixupPackageInfo);

      // for each packagePath found in any packagePaths config item, augment the packages map owned by the loader
      for (baseUrl in config.packagePaths) {
        forEach(config.packagePaths[baseUrl], function(packageInfo) {
          fixupPackageInfo(packageInfo, baseUrl + "/");
        });
      }

      // mix any packageMap config item and recompute the internal packageMapProg
      packageMapProg= computeMapProg(mix(packageMap, config.packageMap));

      // push in any new has values
      for (p in config.hasValues) {
        hasMap[p]= config.hasValues[p];
      }

      if (!booting) {
        (config.load || config.callback) && req(config.load || [], config.callback);
        config.ready && req.addOnLoad(config.ready);
      }
    };

  // configure require; let client-set switches override defaults
  req.has= has;
  mix(req, defaultConfig);
  config(userConfig, 1);

  if (has("loader-traceApi")) {
    // these make debugging nice
    var
      symbols= 
        {},

      symbol= function(name) {
        return symbols[name] || (symbols[name]= {value:name});    
      };

    requested =symbol("requested");
    arrived   =symbol("arrived");
    nonmodule =symbol("not-a-module");
  }

  // at this point req===require is configured; define the loader
  var
    modules=
      // A hash:(pqn) --> (module-object). module objects are simple JavaScript objects with the
      // following properties:
      // 
      //   pid: the package identifier to which the module belongs; "" indicates the system or default package
      //   id: the module identifier without the package identifier
      //   pqn: the full context-qualified name
      //   url: the URL from which the module was retrieved
      //   pack: the package object of the package to which the module belongs
      //   path: the full module name (package + path) resolved with respect to the loader (i.e., mappings have been applied)
      //   executed: 1 <==> the factory has been executed
      //   deps: the dependency vector for this module (vector of modules objects)
      //   def: the factory for this module
      //   result: the result of the running the factory for this module
      //   injected: (requested | arrived | nonmodule) the status of the module; nonmodule means the resource did not call define
      //   ready: 1 <==> all prerequisite fullfilled to execute the module
      //   load: plugin load function; applicable only for plugins
      // 
      // Modules go through several phases in creation:
      // 
      // 1. Requested: some other module's definition contains the requested module in
      //    its dependency vector or executing code explicitly demands a module via req.require.
      // 
      // 2. Injected: a script element has been appended to the head element demanding the resource implied by the URL
      // 
      // 3. Loaded: the resource injected in [2] has been evaluated.
      // 
      // 4. Defined: the resource contained a define statement that advised the loader
      //    about the module. Notice that some resources may just contain a bundle of code
      //    and never formally define a module via define
      // 
      // 5. Evaluated: the module was defined via define and the loader has evaluated the factory and computed a result.
      {},

    execQ=
      ///
      // The list of modules that need to be evaluated.
      [],

    waiting= 
      // The set of modules upon which the loader is waiting.
      {},

    execComplete=
      // says the loader has completed (or not) its work
      function() {
        return defQ && !defQ.length && isEmpty(waiting) && !execQ.length;
      },

    runMapProg= function(targetMid, map) {
      // search for targetMid in map; return the map item if found; falsy otherwise
      for (var i= 0; i<map.length; i++) {
        if (map[i][2].test(targetMid)) {
          return map[i];
        }
      }
      return 0;
    },

    compactPath= function(path, trimLeadingDots) {
      if (!/\./.test(path)) {
        return path;
      }
      var 
        parts= path.split("/"),
        result= [],
        segment;
      while (parts.length) {
        segment= parts.shift();
        if (segment==".." && result.length && result[result.length-1]!="..") {
          result.pop();
        } else if (segment!="." || (!result.length && !trimLeadingDots)) {
          result.push(segment);
        }
      }
      return result.join("/");
    },

    transformPath= function(
      path, 
      transforms
    ) {
      for (var i= 0, result= 0, item; !result && i<transforms.length;) {
        item= transforms[i++];
        if (isFunction(item)) {
          result= item(path);
        } else {
          result= item[0].test(path) && path.replace(item[0], item[1]);
        }
      }
      return result;
    },

    makeModuleInfo= function(pid, mid, pqn, pack, path, url) {
      var result= {pid:pid, mid:mid, pqn:pqn, pack:pack, path:path, url:url};
      return result;
    },

    getModuleInfo= function(mid, referenceModule) {
      var 
        pid= 0,
        pack= 0,
        pqn, plugin, pluginResource, mapProg, mapItem, path, url, match, result;
      match= mid.match(/^(.+?)\!(.+)$/);
      if (match) {
        plugin= getModule(match[1], referenceModule),
        pluginResource= match[2];
        return {plugin:plugin, mid:pluginResource, req:createRequire(referenceModule), pqn:plugin.pqn + "!" + pluginResource};
      }
      if (/(^\/)|(\:)|(\.[^\/]+$)/.test(mid)) {
        // absolute path or prototcol or file type was given; resolve relative to page location.pathname
        // note: this feature is totally unnecessary; you can get the same effect
        // be giving a relative path off of baseUrl or an absolute path
        url= /^\./.test(mid) ? compactPath(req.pagePath + "/../" + mid) : mid;
        return makeModuleInfo(0, url, "*" + url, 0, url, url);
      } else {
        if (/^\./.test(mid)) {
          // relative module ids are relative to the referenceModule if provided, otherwise the baseUrl
          mid= referenceModule ? referenceModule.path + "/../" + mid : req.baseUrl + mid;
        }
        // get rid of all the dots
        path= compactPath(mid, true);
        // find the package indicated by the module id, if any
        mapProg= referenceModule && referenceModule.pack && referenceModule.pack.mapProg;
        mapItem= (mapProg && runMapProg(path, mapProg)) || runMapProg(path, packageMapProg);
        if (mapItem) {
          // mid specified a module that's a member of a package; figure out the package id and module id
          pid= mapItem[1];
          mid= path.substring(mapItem[3]);
        } else {
          pid= "";
          mid= path;
        }
        pqn= pid + "*" + mid;
        if (modules[pqn]) {
          return modules[pqn];
        }
      }
      if (pid) {
        // mid specified a module that's a member of a package; figure out the package id and module id
        pack= packages[pid];
        path= pid + "/" + (mid || pack.main);
        url= transformPath(path, pack.pathTransforms) || 
             pack.location + "/" + (pack.lib ? pack.lib + "/" : "") + (mid || pack.main);
        if (has("loader-requirejsApi")) {
          mapItem= runMapProg(url, pathsMapProg);
          if (mapItem) {
            url= mapItem[1] + url.substring(mapItem[3]-1);
          }
        }
      } else {
        // the pathsMap is only applied to non-package modules
        mapItem= runMapProg(path, pathsMapProg);
        if (mapItem) {
          url= mapItem[1] + path.substring(mapItem[3]-1);
        } else {
          url= transformPath(path, pathTransforms) || path;
        }
      }
      // if result is not absolute, add baseUrl
      if (!(/(^\/)|(\:)/.test(url))) {
        url= req.baseUrl + url;
      }
      url+= ".js";
      return makeModuleInfo(pid, mid, pqn, pack, path, compactPath(url));
    },

    getModule= function(mid, referenceModule) {
      // compute and optionally construct (if necessary) the module implied by the mid with respect to referenceModule
      var 
        result= getModuleInfo(mid, referenceModule),
        existing= modules[result.pqn];
      return existing || (modules[result.pqn]= result);
    },

    nameToUrl= function(name, ext, referenceModule) {
      var 
        match= name.match(/(.+)(\.[^\/]+)$/),
        url= getModuleInfo(match && match[1] || name, referenceModule).url;
      return url.substring(0, url.length-3) + (ext ? ext : (match ? match[2] : ""));
    },
      
    cjsModuleInfo= {
      injected: arrived,
      deps: [],
      executed: 1,
      result: 1
    },
    cjsRequireModule= mix(getModule("require"), cjsModuleInfo),
    cjsExportsModule= mix(getModule("exports"), cjsModuleInfo),
    cjsModuleModule= mix(getModule("module"), cjsModuleInfo),

    runFactory= function(pqn, factory, args, cjs) {
      if (has("loader-traceApi")) {
        req.trace("loader-runFactory", [pqn]);
      }
      return isFunction(factory) ? (factory.apply(null, args) || (cjs && cjs.exports)) : factory;
    },

    makeCjs= function(module) {
      if (!module.cjs) {
        module.cjs= {
          id: module.path,
          uri: module.url,
          exports: {},
          setExports: function(exports) {
            module.cjs.exports= exports;
          }
        };
      }
      return module.cjs;
    },

    evalOrder= 0,

    execModule= function(
      module
    ) {
      // run the dependency vector, then run the factory for module
      if (!module.executed) {
        var
          pqn= module.pqn,
          deps= module.deps || [],
          arg, 
          args= [], 
          i= 0;

        if (has("loader-traceApi")) {
          req.trace("loader-execModule", [pqn]);
        }

        // guard against circular dependencies
        module.executed= 1;
        while (i<deps.length) {
          arg= deps[i++];
          args.push((arg===cjsRequireModule) ? createRequire(module) :
                                               ((arg===cjsExportsModule) ? makeCjs(module).exports :
                                                                           ((arg===cjsModuleModule) ? makeCjs(module) :
                                                                                                      execModule(arg))));
        }
        if (has("loader-catchApi")) {
          try {
            module.result= runFactory(pqn, module.def, args, module.cjs);
          } catch (e) {
            if (!has("loader-errorApi") || !req.onError("loader/exec", [e, pqn].concat(args))) {
              throw e;
            }
          }
        } else {
          module.result= runFactory(pqn, module.def, args, module.cjs);
        }
        module.evalOrder= evalOrder++;
        if (module.loadQ) {
          // this was a plugin module
          var
            q= module.loadQ,
            load= module.load= module.result.load;
          while (q.length) {
            load.apply(null, q.shift());
          }
        }
        if (has("loader-traceApi")) {
          req.trace("loader-execModule-out", [pqn]);
        }
      }
      return module.result;
    },

    checkCompleteTimer= 0,
    checkComplete= function() {
      if (has("loader-throttleCheckComplete")) {
        if (!checkCompleteTimer) {
          checkCompleteTimer= req.timer= setInterval(
            function() { 
              doCheckComplete(); 
            }, 50);
        }
      } else {
        doCheckComplete();
      }
    },

    checkCompleteRecursiveGuard= 0,
    doCheckComplete= function() {
      if (checkCompleteRecursiveGuard) {
        return;
      }
      checkCompleteRecursiveGuard= 1;

      var 
        readySet= {},
        rerun= 1,
        notReadySet, visited, module, i,
        ready= function(module) {
          var pqn= module.pqn;
          if (readySet[pqn] || visited[pqn]) {
            return 1;
          }
          visited[pqn]= 1;
          if ((!module.executed && !module.def) || notReadySet[pqn]) {
            notReadySet[module.pqn]= 1;
            return 0;
          }
          for (var deps= module.deps, i= 0; deps && i<deps.length;) {
            if (!ready(deps[i++])) {
              notReadySet[pqn]= 1;
              return 0;
            }
          }
          readySet[pqn]= 1;
          return 1;
        };

      while (rerun) {
        notReadySet= {};
        rerun= 0;
        for (i= 0; i<execQ.length;) {
          visited= {};
          module= execQ[i];
          if (module.executed) {
            execQ.splice(i, 1);
          } else if (ready(module)) {
            execModule(module);
            execQ.splice(i, 1);
            // executing a module may result in a plugin calling load which
            // may result in yet another module becoming ready; therefore,
            rerun= 1;
          } else {
            i++;
          }
        }
      }

      checkCompleteRecursiveGuard= 0;
      if (!execQ.length && checkCompleteTimer) {
        clearInterval(checkCompleteTimer);
        checkCompleteTimer= req.timer= 0;
      }
      if (has("loader-pageLoadApi")) {
        onLoad();
      }
    };

  if (has("loader-injectApi")) {
    var
      injectedUrls= 
        ///
        // hash:(pqn)-->(requested | arrived)
        ///
        //note
        // `requested` and `arrived` give "symbol-like" behavior since JavaScript doesn't have symbole; See
        // bd.symbol for an in-depth explanation.
        //
        {},
 
      cache= 
        ///
        // hash:(pqn)-->(function)
        ///
        // Gives the contents of a cached script; function should cause the same actions as if the given pqn was downloaded
        // and evaluated by the host environment
        req.cache || {},
  
      injectPlugin= function(
        module
      ) {
        // injects the plugin module given by module; may have to inject the plugin itself
        var 
          pqn= module.pqn,
          onload= function(def) {
            mix(module, {executed:1, result:def});           
            setDel(waiting, pqn);
            checkComplete();
          };
        if (cache[pqn]) {
          onload(cache[pqn]);
        } else {
          var plugin= module.plugin;
          if (!plugin.load) {
            plugin.loadQ= [];
            plugin.load= function(require, id, callback) {
              plugin.loadQ.push([require, id, callback]);
            };
            injectModule(plugin);
          }
          setIns(waiting, pqn);
          plugin.load(module.req, module.mid, onload);
        }
      },

      injectModule= function(
        module
      ) {
        // Inject the module. In the browser environment, this means appending a script element into 
        // the head; in other environments, it means loading a file.
  
        var pqn= module.pqn;
        if (module.injected || waiting[pqn]) {
          return;
        }
        if (module.plugin) {
          injectPlugin(module);
          return;
        }
    
        // a normal module (not a plugin)
        module.injected= requested;
        setIns(waiting, pqn);
        var url= module.url;
        if (injectedUrls[url]) {
          // the script has already been requested (two different modules resolve to the same URL)
          return;
        }
  
        // the url implied by module has not been requested; therefore, request it
        // note that it is possible for two different pqns to imply the same url
        injectedUrls[url]= requested;
        var onLoadCallback= function() { 
          injectedUrls[url]= arrived;
          setDel(waiting, pqn);
          runDefQ(module);
          if (module.injected!==arrived) {
            // the script that contained the module arrived and has been executed yet
            // the injected prop was not advanced to arrived; therefore, onModule must
            // not have been called; therefore, it must not have been a module (it was
            // just some code); adjust state accordingly
            mix(module, {
              injected: arrived,
              deps: [],
              def: nonmodule,
              result: nonmodule
            });
          }
          checkComplete();
        };
        if (cache[pqn]) {
          cache[pqn].call(null);
          onLoadCallback();
        } else {
          req.injectUrl(url, onLoadCallback);
          startTimer();
        }
      },

      defQ= 
        // The queue of define arguments sent to loader.
        [],
  
      defineModule= function(module, deps, def, url) {
        if (has("loader-traceApi")) {
          req.trace("loader-defineModule", [module, deps]);
        }
  
        var pqn= module.pqn;
        if (module.injected==arrived) {
          req.onError("loader/multiple-define", [pqn]); 
          return module;
        }
        mix(module, {
          injected: arrived,
          url: url,
          deps: deps,
          def: def
        });

        // resolve deps with respect to pid
        for (var i= 0; i<deps.length; i++) {
          deps[i]= getModule(deps[i], module);
        }
        
        setDel(waiting, pqn);
        execQ.push(module);
  
        // don't inject dependencies; wait until the current script has completed executing and then inject. 
        // This allows several definitions to be contained within one script without prematurely requesting
        // resources from the server.

        return module;
      },
  
      runDefQ= function(referenceModule) {
        //defQ is an array of [id, dependencies, factory]
        var
          definedModules= [],
          args;
        while (defQ.length) {
          args= defQ.shift();
          // explicit define indicates possible multiple modules in a single file; delay injecting dependencies until defQ fully
          // processed since modules earlier in the queue depend on already-arrived modules that are later in the queue
          definedModules.push(defineModule(args[0] && getModule(args[0]) || referenceModule, args[1], args[2], referenceModule.url));
        }
        forEach(definedModules, injectDependencies);
      };
  }
 
  if (has("loader-timeoutApi")) {
    var
      // Timer machinery that monitors how long the loader is waiting and signals
      // an error when the timer runs out.
      timerId=
        0,
  
      clearTimer= function() {
        timerId && clearTimeout(timerId);
        timerId= 0;
      },
  
      startTimer= function() {
        clearTimer();
        req.timeout && (timerId= setTimeout(function() { 
          clearTimer();
          req.onError("loader/timeout", [waiting]); 
        }, req.timeout));
      };
  } else {
    var 
      clearTimer= noop,
      startTimer= noop;
  }

  if (has("dom")) {
    var doc= document;

    if (has("loader-pageLoadApi") || has("loader-injectApi")) {
      var on= function(node, eventName, handler, useCapture, ieEventName) {
        // Add an event listener to a DOM node using the API appropriate for the current browser; 
        // return a function that will disconnect the listener.
        if (has("dom-addEventListener")) {
          node.addEventListener(eventName, handler, !!useCapture);
          return function() {
            node.removeEventListener(eventName, handler, !!useCapture);
          };
        } else {
          if (ieEventName!==false) {
            eventName= ieEventName || "on"+eventName;
            node.attachEvent(eventName, handler);
            return function() {
              node.detachEvent(eventName, handler);
            };
          } else {
            return noop;
          }
        }
      };
    }

    if (has("loader-injectApi")) {
      var head= doc.getElementsByTagName("head")[0] || doc.getElementsByTagName("html")[0];
      req.injectUrl= req.injectUrl || function(url, callback) {
        // Append a script element to the head element with src=url; apply callback upon 
        // detecting the script has loaded.
        var 
          node= doc.createElement("script"),
          onLoad= function(e) {
            e= e || window.event;
            var node= e.target || e.srcElement;
            if (e.type==="load" || /complete|loaded/.testy(node.readyState)) {
              disconnector();
              callback && callback.call();
            }
          },
          disconnector= on(node, "load", onLoad, false, "onreadystatechange");
        node.src= url;
        node.type= "text/javascript";
        node.charset= "utf-8";
        head.appendChild(node);
      };  
    }

    if (has("loader-sniffApi")) {
      // TODO: check that requirejs only sniff is not baseUrl
      if (!req.baseUrl) {
        req.baseUrl= "";
        for (var match, src, dataMain, scripts= doc.getElementsByTagName("script"), i= 0; i<scripts.length; i++) {
          src= scripts[i].getAttribute("src") || "";
          if ((match= src.match(/require\.js$/))) {
            req.baseUrl= src.substring(0, match.index) || "./";
            dataMain= scripts[i].getAttribute("data-main");
            if (dataMain) {
              userConfig.load=  userConfig.load || [dataMain];
            }
            // remember the base node so other machinery can use it to pass parameters (e.g., djConfig)
            req.baseNode= scripts[i];
            break;
          }
        }
      }
    }

    if (has("loader-pageLoadApi")) {
      // page load detect code derived from Dojo, Copyright (c) 2005-2010, The Dojo Foundation. Use, modification, and distribution subject to terms of license.

      //warn
      // document.readyState does not work with Firefox before 3.6. To support
      // those browsers, manually init require.pageLoaded in configuration.
    
      // require.pageLoaded can be set truthy to indicate the app "knows" the page is loaded and/or just wants it to behave as such
      req.pageLoaded= req.pageLoaded || document.readyState=="complete";

      // no need to detect if we already know...
      if (!req.pageLoaded) {
        var
          loadDisconnector= 0,
          DOMContentLoadedDisconnector= 0,
          scrollIntervalId= 0,
          detectPageLoadedFired= 0,
          detectPageLoaded= function() {
            if (detectPageLoadedFired) {
              return;
            }
            detectPageLoadedFired= 1;
      
            if (scrollIntervalId) {
              clearInterval(scrollIntervalId);
              scrollIntervalId = 0;
            }
            loadDisconnector && loadDisconnector();
            DOMContentLoadedDisconnector && DOMContentLoadedDisconnector();
            req.pageLoaded= true;
            onLoad();
          };
      
        if (!req.pageLoaded) {
          loadDisconnector= on(window, "load", detectPageLoaded, false);
          DOMContentLoadedDisconnector= on(doc, "DOMContentLoaded", detectPageLoaded, false, false);
        }

        if (!has("dom-addEventListener")) {
          // note: this code courtesy of James Burke (https://github.com/jrburke/requirejs)
          //DOMContentLoaded approximation, as found by Diego Perini:
          //http://javascript.nwbox.com/IEContentLoaded/
          if (self === self.top) {
            scrollIntervalId = setInterval(function () {
              try {
                //From this ticket:
                //http://bugs.dojotoolkit.org/ticket/11106,
                //In IE HTML Application (HTA), such as in a selenium test,
                //javascript in the iframe can't see anything outside
                //of it, so self===self.top is true, but the iframe is
                //not the top window and doScroll will be available
                //before document.body is set. Test document.body
                //before trying the doScroll trick.
                if (doc.body) {
                  doc.documentElement.doScroll("left");
                  detectPageLoaded();
                }
              } catch (e) {}
            }, 30);
          }
        }
      }

      var 
        loadQ= 
          // The queue of functions waiting to execute as soon as all conditions given
          // in require.onLoad are satisfied; see require.onLoad
          [],

        onLoadRecursiveGuard= 0,
        onLoad= function() {
          while (execComplete() && !checkCompleteRecursiveGuard && !onLoadRecursiveGuard && req.pageLoaded && loadQ.length) {
            //guard against recursions into this function
            onLoadRecursiveGuard= true;
            var f= loadQ.shift();
            if (has("loader-catchApi")) {
              try {
                f();
              } catch (e) {
                onLoadRecursiveGuard= 0;
                if (!req.onError("loader/onLoad", [e])) {
                  throw e;
                }
              }
            } else {
              f();
            }
            onLoadRecursiveGuard= 0;
          }
        };

      req.addOnLoad= function(
        context, //(object) The context in which to run execute callback
                 //(function) callback, if context missing
        callback //(function) The function to execute.
      ) {
        ///
        // Add a function to execute on DOM content loaded and all requests have arrived and been evaluated.
    
        if (callback) {
          isString(callback) && (callback= context[callback]);
          loadQ.push(function() {
            callback.call(context);
          });
        } else {
          loadQ.push(context);
        }
        onLoad();
      };
      if (has("loader-requirejsApi")) {
        req.ready= req.addOnLoad;
      }
    }
  }

  if (has("loader-traceApi")) {
    req.trace= function(
      group, // the trace group to which this application belongs
      args   // the contents of the trace
    ) {
      ///
      // Tracing interface by group.
      // 
      // Sends the contents of args to the console iff require.trace[group] is truthy.
      if (req.traceSet[group]) {
        if (has("console-log-apply")) {
          console.log.apply(console, [group+": "].concat(args));
        } else {
          //IE...
          for (var i= 0; i<args.length; i++) {
            console.log(args[i]);
          }
        }
      }
    };
  } else {
    req.trace= req.trace || noop;
  }

  //
  // Error Detection and Recovery
  //
  // Several things can go wrong during loader operation:
  //
  // * A resource may not be accessible, giving a 404 error in the browser or a file error in other environments
  //   (this is usally caught by a loader timeout (see require.timeout) in the browser environment).
  // * The loader may timeout (after the period set by require.timeout) waiting for a resource to be delivered.
  // * Executing a module may cause an exception to be thrown.
  // * Executing the onLoad queue may cause an exception to be thrown.
  // 
  // In all these cases, the loader publishes the problem to interested subscribers via the function require.onError.
  // If the error was an uncaught exception, then if some subscriber signals that it has taken actions to recover 
  // and it is OK to continue by returning truthy, the exception is quashed; otherwise, the exception is rethrown. 
  // Other error conditions are handled as applicable for the particular error.
  if (has("loader-errorApi")) {
    var onError= req.onError= 
      function(
        messageId, //(string) The topic to publish
        args       //(array of anything, optional, []) The arguments to be applied to each subscriber.
      ) {
        ///
        // Publishes messageId to all subscribers, passing args; returns result as affected by subscribers.
        ///
        // A listener subscribes by writing
        // 
        //code
        // require.onError.listeners.push(myListener);
        ///
        // The listener signature must be `function(messageId, args`) where messageId indentifies 
        // where the exception was caught and args is an array of information gathered by the catch
        // clause. If the listener has taken corrective actions and want to stop the exception and
        // let the loader continue, it must return truthy. If no listener returns truthy, then
        // the exception is rethrown.
    
        for (var errorbacks= onError.listeners, result= false, i= 0; i<errorbacks.length; i++) {
          result= result || errorbacks[i](messageId, args);
        }
        console.error(messageId, args);
        onError.log.push(args);
        return result;
      };
    onError.listeners= [];
    onError.log= [];
  } else {
    req.onError= req.onError || noop;
  }

  if (has("loader-createHasModule")) {
    mix(getModule("has"), {injected:arrived, deps:[], executed:1, result:has});
  }

  mix(req, {
    isEmpty:isEmpty,
    isFunction:isFunction,
    isString:isString,
    isArray:isArray,
    forEach:forEach,
    setIns:setIns,
    setDel:setDel,
    mix:mix,
    uid:uid,
    on:on,
    paths:paths,
    pathTransforms:pathTransforms,
    packages:packages,
    modules:modules,
    execQ:execQ,
    defQ:defQ,
    waiting:waiting,
    injectedUrls:injectedUrls,
    cache:cache,
    loadQ:loadQ
  });

  if (has("loader-node")) {
    global.define= def;
    global.require= req;
  } else {
    define= def;
    require= req;
  }

  if (has("loader-requirejsApi")) {
    req.ready= req.addOnLoad;
    req.autoLoad= [];
    req.def= define;
  }

  if (has("loader-injectApi")) {
    req(userConfig.load || req.autoLoad || [], userConfig.callback);
    userConfig.ready && loadQ.push(userConfig.ready);
  } else {
    // the cache holds a map from absolute module id to {deps, def} of all modules that should be instantiated
    (function() {
      var
        cache= req.cache,
        p, module, deps, i;
      for (p in cache) {
        module= cache[p];
        mix(module, getModuleInfo(p));
        modules[module.pqn]=module;
        execQ.push(module);
      }
      for (p in modules) {
        for (module= modules[p], deps= module.deps, i= 0; i<deps.length; i++) {
          deps[i]= getModule(deps[i], module);
        }
      }
      doCheckComplete();
    })();
  }
})
// begin default bootstrap configuration
// note: typically, some or all of these arguments are replaced when compiling the loader for a particular target
(
  // the use can send in a configuration by defining a global require object
  this.require || {}, 

  // default configuration
  {
    baseUrl:""
    ,pagePath:location.pathname
    ,host:"browser"
    ,isBrowser:1
    ,timeout:0
    ,autoLoad:["config"]
    ,traceSet:{
      "loader-define":0
      ,"loader-runFactory":0
      ,"loader-execModule":0
      ,"loader-execModule-out":0
      ,"loader-defineModule":0
    }
  },

  // default has switches
  {
    "dom":!!this.document,
    "dom-addEventListener":this.document && !!document.addEventListener,
    "console":typeof console!="undefined",
    "console-log-apply":!!(typeof console!="undefined" && console.log && console.log.apply),
    "loader-injectApi":1,
    "loader-timeoutApi":1,
    "loader-traceApi":1,
    // TODOC: deleted... "loader-buildToolsApi":1,
    "loader-catchApi":1,
    "loader-pageLoadApi":1,
    "loader-errorApi":1,
    "loader-sniffApi":1,
    "loader-undefApi":1,
    "loader-requirejsApi":1,
    // TODOC: deleted... "loader-pushHas":1,
    "loader-createHasModule":1,
    "loader-amdFactoryScan":1,
    "loader-throttleCheckComplete":1,
    "native-xhr":!!this.XMLHttpRequest
  },

  // has.js
  this.has
);
// Copyright (c) 2008-2010, Rawld Gill and ALTOVISO LLC (www.altoviso.com). Use, modification, and distribution subject to terms of license.
