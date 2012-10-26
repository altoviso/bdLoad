(function(global){
	// summary:
	//		This is a minimal, optimized (time and space) AMD loader.
	// description:
	//		TODOC
	//
	// Language and Acronyms and Idioms
	//
	// moduleId: a CJS module identifier, (used for public APIs)
	// mid: moduleId (used internally)
	// pid: package identifier
	// pack: pack is used internally to reference a package object (since javascript has reserved words including "package")
	// prid: plugin resource identifier
	// The integer constant 1 is used in place of true.
	//

	var
		req = function(
			dependencies, //(array of commonjs.moduleId, optional) list of modules to be loaded before applying callback
			callback      //(function, optional) lamda expression to apply to module values implied by dependencies
		){
			// the global require function
			return contextRequire(dependencies, callback);
		},

		//
		// loader state data
		//
		baseUrl =
			// AMD baseUrl config
			"./",

		paths
			// AMD paths config
			= {},


		packages,
			// AMD packages config

		packs
			// a map from pid to package configuration object; see fixupPackageInfo
			= {},

		pathsMapProg
			// list of (from-path, to-path, regex, length) derived from paths;
			// a "program" to apply paths; see computeMapProg
			= [],

		map
			// AMD map config variable
			= {},

		mapProgs
			// vector of quads as described by computeMapProg; map-key is AMD map key, map-value is AMD map value
			= [],

		modules
			// A hash:(mid) --> (module-object) the module namespace
			//
			// pid: the package identifier to which the module belongs (e.g., "dojo"); "" indicates the system or default package
			// mid: the fully-resolved (i.e., mappings have been applied) module identifier without the package identifier (e.g., "dojo/io/script")
			// url: the URL from which the module was retrieved
			// pack: the package object of the package to which the module belongs
			// executed: falsy => not executed; executing => in the process of tranversing deps and running factory; 1 => factory has been executed
			// deps: the dependency vector for this module (vector of modules objects)
			// def: the factory for this module
			// result: the result of the running the factory for this module
			// injected: 1 => module has been injected
			// load, dynamic, normalize: plugin functions applicable only for plugins
			//
			// Modules go through several phases in creation:
			//
			// 1. Requested: some other module's definition or a require application contained the requested module in
			//    its dependency vector
			//
			// 2. Injected: a script element has been appended to the insert-point element demanding the resource implied by the URL
			//
			// 3. Loaded: the resource injected in [2] has been evalated.
			//
			// 4. Defined: the resource contained a define statement that advised the loader about the module.
			//
			// 5. Evaluated: the module was defined via define and the loader has evaluated the factory and computed a result.
			= {},

		cache
			// hash:(mid | url)-->(function | string)
			//
			// A cache of resources. The resources arrive via a require.cache application, which takes a hash from either mid --> function or
			// url --> string. The function associated with mid keys causes the same code to execute as if the module was script injected.
			//
			// Both kinds of key-value pairs are entered into cache via the function consumePendingCache, which may relocate keys as given
			// by any mappings *iff* the cache was received as part of a module resource request.
			= {},

		pendingCacheInsert
			// hash:(mid | url)-->(function | string)
			//
			// Gives a set of cache modules pending entry into cache. When cached modules are published to the loader, they are
			// entered into pendingCacheInsert; modules are then pressed into cache upon (1) AMD define or (2) upon receiving another
			// independent set of cached modules. (1) is the usual case, and this case allows normalizing mids given in the pending
			// cache for the local configuration, possibly relocating modules.
			= {},


		forEach = function(vector, callback){
			vector && vector.forEach(callback);
		},

		mix = function(dest, src){
			for(var p in src){
				dest[p] = src[p];
			}
			return dest;
		},

		signal = function(type, args){ req.signal(type, args); },

		consumePendingCacheInsert = function(referenceModule){
			var p, item;
			for(p in pendingCacheInsert){
				item = pendingCacheInsert[p];
				// item.match indicates item is a string
				cache[item.match ? toUrl(p, referenceModule) : getModuleInfo(p, referenceModule).mid] =  item;
			}
			pendingCacheInsert = {};
		},

		uidGenerator = 0,

		Error = function(module){
			mix(this, module);
		},

		contextRequire = function(a1, a2, referenceModule){
			var module;
			if(a1.match){
				// a1 is a string; therefore, signature is (moduleId)
				if((module = getModule(a1, referenceModule)).executed!=1){
					throw new Error(module);
				}
			}else{
				// signature is (requestList [,callback])
				// construct a synthetic module to control execution of the requestList, and, optionally, callback
				mix((module = getModuleInfo("*" + uidGenerator++)), {
					deps: resolveDeps(a1, module, referenceModule),
					def: a2 || {},
					gc: 1 //garbage collect
				});
				guardCheckComplete(function(){
					forEach(module.deps, injectModule);
				});
				execQ.push(module);
				checkComplete();
			}
			return module;
		},

		createRequire = function(module){
			var result = (!module && req) || module.require;
			if(!result){
				module.require = result = function(a1, a2){
					return contextRequire(a1, a2, module);
				};
				mix(mix(result, req), {
					toUrl:function(name){
						return toUrl(name, module);
					},
					toAbsMid:function(mid){
						return toAbsMid(mid, module);
					}
				});
			}
			return result;
		},

		execQ =
			// The list of modules that need to be evaluated.
			[],

		defArgs =
			// The arguments sent to loader via AMD define().
			0,

		waitingCount =
			// the number of modules the loader has injected but has not seen defined
			0,

		runMapProg = function(targetMid, map){
			// search for targetMid in map; return the map item if found; falsy otherwise
			if(map){
				for(var i = 0; i < map.length; i++){
					if(map[i][2].test(targetMid)){
						return map[i];
					}
				}
			}
			return 0;
		},

		compactPath = function(path){
			var result = [],
				segment, lastSegment;
			path = path.replace(/\\/g, '/').split('/');
			while(path.length){
				segment = path.shift();
				if(segment==".." && result.length && lastSegment!=".."){
					result.pop();
					lastSegment = result[result.length - 1];
				}else if(segment!="."){
					result.push(lastSegment= segment);
				} // else ignore "."
			}
			return result.join("/");
		},

		getModuleInfo = function(mid, referenceModule){
			var match, pid, pack, midInPackage, mapProg, mapItem, url, result;

			// relative module ids are relative to the referenceModule; get rid of any dots
			mid = compactPath(/^\./.test(mid) ? (referenceModule.mid + "/../" + mid) : mid);
			// at this point, mid is an absolute mid

			// map the mid
			if((mapItem = runMapProg(mid, (referenceModule && runMapProg(referenceModule.mid, mapProgs) || mapProgs.star)))){
				mid = mapItem[1] + mid.substring(mapItem[3]);
			}

			match = mid.match(/^([^\/]+)(\/(.+))?$/);
			pid = match ? match[1] : "";
			if((pack = packs[pid])){
				mid = pid + "/" + (midInPackage = (match[3] || pack.main));
			}else{
				pid = "";
			}

			if(!(result = modules[mid])){
				mapItem = runMapProg(mid, pathsMapProg);
				url = mapItem ? mapItem[1] + mid.substring(mapItem[3]) : (pid ? pack.location + "/" + midInPackage : mid);
				result = {pid:pid, mid:mid, pack:pack, url:compactPath((/(^\/)|(\:)/.test(url) ? "" : baseUrl) + url + ".js")};
			}
			return result;
		},

		resolvePluginResourceId = function(plugin, prid, contextRequire){
			return plugin.normalize ? plugin.normalize(prid, contextRequire.toAbsMid) : contextRequire.toAbsMid(prid);
		},

		getModule = function(mid, referenceModule){
			// compute and construct (if necessary) the module implied by the mid with respect to referenceModule
			var match, plugin, prid, result, contextRequire, loaded;
			match = mid.match(/^(.+?)\!(.*)$/);
			if(match){
				// name was <plugin-module>!<plugin-resource-id>
				plugin = getModule(match[1], referenceModule);
				loaded = plugin.load;

				contextRequire = createRequire(referenceModule);

				if(loaded){
					prid = resolvePluginResourceId(plugin, match[2], contextRequire);
					mid = (plugin.mid + "!" + (plugin.dynamic ? ++uidGenerator + "!" : "") + prid);
				}else{
					// if the plugin has not been loaded, then can't resolve the prid and must assume this plugin is dynamic until we find out otherwise
					prid = match[2];
					mid = plugin.mid + "!" + (++uidGenerator) + "!*";
				}
				result = {plugin:plugin, mid:mid, req:contextRequire, prid:prid, fix:!loaded};
			}else{
				result = getModuleInfo(mid, referenceModule);
			}
			return  modules[result.mid] || (modules[result.mid] = result);
		},

		toAbsMid = function(mid, referenceModule){
			return getModuleInfo(mid, referenceModule).mid;
		},

		toUrl = function(name, referenceModule){
			var moduleInfo = getModuleInfo(name+"/x", referenceModule),
				url= moduleInfo.url;
			// "/x.js" since getModuleInfo automatically appends ".js" and we appended "/x" to make name look likde a module id
			return url.substring(0, url.length-5);
		},

		makeCjs = function(mid){
			return modules[mid] = {mid:mid, injected: 1, executed: 1};
		},

		cjsRequireModule = makeCjs("require"),
		cjsExportsModule = makeCjs("exports"),
		cjsModuleModule = makeCjs("module"),

		executing = {},
		abortExec = {},
		executedSomething,

		execModule = function(module){
			// run the dependency vector, then run the factory for module
			if(module.executed === executing){
				// for circular dependencies, assume the first module encountered was executed OK
				// modules that circularly depend on a module that has not run its factory will get
				// the premade cjs.exports===module.result. They can take a reference to this object and/or
				// add properties to it. When the module finally runs its factory, the factory can
				// read/write/replace this object. Notice that so long as the object isn't replaced, any
				// reference taken earlier while walking the deps list is still valid.
				return module.cjs.exports;
			}

			if(!module.executed){
				if(!module.def){
					return abortExec;
				}
				var mid = module.mid,
					deps = module.deps,
					factory = module.def,
					result, args;

				module.executed = executing;
				args = deps.map(function(dep){
					if(result!==abortExec){
						result = ((dep === cjsRequireModule) ? createRequire(module) :
									((dep === cjsExportsModule) ? module.cjs.exports :
										((dep === cjsModuleModule) ? module.cjs :
											execModule(dep))));
					}
					return result;
				});
				if(result===abortExec){
					module.executed = 0;
					return abortExec;
				}
				try{
					result= typeof factory == "function" ? factory.apply(null, args) : factory;
				}catch(e){
					signal("factoryThrew", [result = e, module]);
				}
				module.result = result===undefined && module.cjs ? module.cjs.exports : result;
				module.executed = 1;
				executedSomething = 1;

				// delete references to synthetic modules
				if(module.gc){
					delete modules[module.mid];
				}

				// if result defines load, just assume it's a plugin; harmless if the assumption is wrong
				result && result.load && ["dynamic","normalize","load"].forEach(function(p){
					module[p] = result[p];
				});


				// for plugins, resolve the loadQ
				forEach(module.loadQ, function(pseudoPluginResource){
					// manufacture and insert the real module in modules
					var prid = resolvePluginResourceId(module, pseudoPluginResource.prid, pseudoPluginResource.req),
						mid = module.dynamic ? pseudoPluginResource.mid.replace(/\*$/, prid) : (module.mid + "!" + prid),
						pluginResource = mix(mix({}, pseudoPluginResource), {mid:mid, prid:prid});
					if(!modules[mid]){
						// create a new (the real) plugin resource and inject it normally now that the plugin is on board
						injectPlugin(modules[mid] = pluginResource);
					} // else this was a duplicate request for the same (plugin, rid) for a nondynamic plugin

					// pluginResource is really just a placeholder with the wrong mid (because we couldn't calculate it until the plugin was on board)
					// fix() replaces the pseudo module in a resolved deps vector with the real module
					// lastly, mark the pseuod module as arrived and delete it from modules
					pseudoPluginResource.fix(modules[mid]);
					--waitingCount;
					delete modules[pseudoPluginResource.mid];
				});
				delete module.loadQ;
			}
			// at this point the module is guaranteed fully executed
			return module.result;
		},

		checkCompleteGuard = 0,

		guardCheckComplete = function(proc){
			checkCompleteGuard++;
			proc();
			checkCompleteGuard--;
			!defArgs && !waitingCount && !execQ.length && !checkCompleteGuard && signal("idle", []);
		},

		checkComplete = function(){
			// keep going through the execQ as long as at least one factory is executed
			// plugins, recursion, cached modules all make for many execution path possibilities
			!checkCompleteGuard && guardCheckComplete(function(){
				for(var module, i = 0; i < execQ.length;){
					module = execQ[i];
					if(module.executed==1){
						execQ.splice(i, 1);
					}else{
						executedSomething = 0;
						execModule(module);
						if(executedSomething){
							// something was executed; this indicates the execQ was modified, maybe a
							// lot (for example a later module causes an earlier module to execute)
							i = 0;
						}else{
							// nothing happened; check the next module in the exec queue
							i++;
						}
					}
				}
			});
		},

		injectPlugin = function(
			module
		){
			// injects the plugin module given by module; may have to inject the plugin itself
			var plugin = module.plugin,
				onLoad = function(def){
					module.result = def;
					waitingCount--;
					module.executed = 1;
					checkComplete();
				};

			if(plugin.load){
				plugin.load(module.prid, module.req, onLoad);
			}else if(plugin.loadQ){
				plugin.loadQ.push(module);
			}else{
				// the unshift instead of push is important: we don't want plugins to execute as
				// dependencies of some other module because this may cause circles when the plugin
				// loadQ is run; also, generally, we want plugins to run early since they may load
				// several other modules and therefore can potentially unblock many modules
				plugin.loadQ = [module];
				execQ.unshift(plugin);
				injectModule(plugin);
			}
		},

		injectModule = function(module){
			if(module.plugin){
				injectPlugin(module);
			}else if(!module.injected){
				var cached,
					onLoadCallback = function(){
						// defArgs is an array of [dependencies, factory]
						consumePendingCacheInsert(module);

						defineModule(module, defArgs[0], defArgs[1]);
						defArgs = 0;

						// checkComplete!=0 holds the idle signal; we're not idle if we're injecting dependencies
						guardCheckComplete(function(){
							forEach(module.deps, injectModule);
						});
						checkComplete();
					};

				waitingCount++;
				module.injected = 1;
				if((cached = cache[module.mid])){
					try{
						cached();
						onLoadCallback();
						return;
					}catch(e){
						signal("cachedThrew", [e, module]);
					}
				}
				injectUrl(module.url, onLoadCallback, module);
			}
		},

		resolveDeps = function(deps, module, referenceModule){
			// resolve deps with respect to this module
			return deps.map(function(dep, i){
				var result = getModule(dep, referenceModule);
				if(result.fix){
					result.fix = function(m){module.deps[i] = m;};
				}
				return result;
			});
		},

		defineModule = function(module, deps, def){
			waitingCount--;
			return mix(module, {
				def: def,
				deps: resolveDeps(deps, module, module),
				cjs: {
					id: module.mid,
					uri: module.url,
					exports: (module.result = {}),
					setExports: function(exports){
						module.cjs.exports = exports;
					},
					config:function(){
						return module.config;
					}
				}
			});
		};

	var injectUrl;
	if(typeof document !== 'undefined' && typeof location !== 'undefined'){
		// browser

		var doc = typeof document !== 'undefined' ? document : null,

			domOn = function(node, eventName, handler){
				// Add an event listener to a DOM node using the API appropriate for the current browser;
				// return a function that will disconnect the listener.
				node.addEventListener(eventName, handler, false);
				return function(){
					node.removeEventListener(eventName, handler, false);
				};
			},
	/*
			windowOnLoadListener = domOn(window, "load", function(){
				req.pageLoaded = 1;
				// check this in all but ie
				//doc.readyState!="complete" && (doc.readyState = "complete");
				windowOnLoadListener();
			}),
	*/
			// if the loader is on the page, there must be at least one script element
			// getting its parent and then doing insertBefore solves the "Operation Aborted"
			// error in IE from appending to a node that isn't properly closed; see
			// dojo/tests/_base/loader/requirejs/simple-badbase.html for an example

			insertPoint = doc.getElementsByTagName("script")[0].parentNode;

		injectUrl = function(url, callback, module){
			// insert a script element to the insert-point element with src=url;
			// apply callback upon detecting the script has loaded.
			var node = module.node = doc.createElement("script"),
				handler = function(e){
					loadDisconnector();
					errorDisconnector();
					var node = e.target;
					e.type === "load" ? callback() : signal("injectFailed", [e, module]);
				},
				loadDisconnector = domOn(node, "load", handler),
				errorDisconnector = domOn(node, "error", handler);

			//node.type = "text/javascript";
			//node.charset = "utf-8";
			node.src = url;
			insertPoint.appendChild(node);
			return node;
		};
	}else if(typeof process === "object" && process.versions && process.versions.node && process.versions.v8){
		var vm = require('vm'),
			fs = require('fs');

		// retain the ability to get node's require
		req.nodeRequire = require;
		injectUrl = function(url, callback, module){
			try{
				vm.runInThisContext(fs.readFileSync(url, "utf8"), url);
				callback();
			}catch(e){
				signal('injectFailed', [e, module]);
			}
		};
	}


	// in the browser, global is window
	// in node, global is module.exports
	global.require = mix(req, {
		Error:Error,
		signal:function(){},
		toAbsMid:toAbsMid,
		toUrl:toUrl,

		set:function(_baseUrl, _paths, _packages, _map){
			baseUrl = _baseUrl || baseUrl;
			paths = _paths || paths;
			packages = _packages || packages;
			map = _map || map;

			forEach(packages, function(p){
				packs[p.name] = p;
			});

			function computeMapProg(map){
				// This routine takes a map as represented by a JavaScript object and initializes dest, a vector of
				// quads of (map-key, map-value, refex-for-map-key, length-of-map-key), sorted decreasing by length-
				// of-map-key. The regex looks for the map-key followed by either "/" or end-of-string at the beginning
				// of a the search source. Notice the map-value is irrelevent to the algorithm
				var result = [], p;
				for(p in map){
					result.push([p, map[p], new RegExp("^" + p.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, function(c){ return "\\" + c; }) + "(\/|$)"), p.length]);
				}
				result.sort(function(lhs, rhs){ return rhs[3] - lhs[3]; });
				return result;
			}

			//recompute map and paths programs structures on each config. If you want to
			// keep the existing config, then either don't change these or do this [e.g.]
			//		require.set({map:mix(require.get(map), { some new/altered map values  })});
			mapProgs = computeMapProg(map, mapProgs);
			forEach(mapProgs, function(item){
				item[1] = computeMapProg(item[1], []);
				if(item[0]=="*"){
					mapProgs.star = item[1];
				}
			});
			computeMapProg(paths, pathsMapProg);
		},

		get:function(name){
			return eval(name);
		},

		cache:function(cache){
			consumePendingCacheInsert();
			pendingCacheInsert = cache;
		}
	});

	// in node |this| is the actual global object and global is module.exports
	// in the browser, |this| and global are the same object
	this.define = global.define = function(
		deps,   //(array of commonjs.moduleId, optional)
		factory	//(any)
	){
		if(arguments.length==1){
			factory = deps;
			deps = ["require", "exports", "module"];
		}
		defArgs = [deps, factory];
	};
})(this);
// Copyright (c) 2008-2012, Rawld Gill and ALTOVISO LLC (www.altoviso.com). Use, modification, and distribution subject to terms of license.
