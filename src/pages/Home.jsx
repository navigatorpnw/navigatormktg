export default function Home() {
  return (
    <div>
      {/* Hero */}
      <section className="py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <img
            alt="Navigator PNW LLC Logo"
            className="mx-auto mb-0 h-80 w-auto"
            src="/navigator-logo.png"
          />
        </div>
      </section>

      {/* Tagline */}
      <section className="py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl md:text-3xl font-bold text-center text-gray-800 mb-12">
            Online resources for the boating community in the Pacific Northwest.
          </h2>

          {/* Feature Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
            {/* Fuel Docks App */}
            <div className="bg-gray-50 rounded-xl p-8 text-center">
              <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-10 h-10 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              </div>
              <h3 className="text-xl font-bold text-gray-800 mb-2">Fuel Docks App</h3>
              <p className="text-gray-600 mb-6">
                Find fuel docks for gas or diesel around the Puget Sound. Available at fueldocks.app
              </p>
              <a
                href="https://fueldocks.app"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block bg-gray-800 text-white px-6 py-3 rounded-lg font-medium hover:bg-gray-700 transition-colors"
              >
                Visit Fuel Docks App
              </a>
            </div>

            {/* Navigator YouTube Channel */}
            <div className="bg-gray-50 rounded-xl p-8 text-center">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-10 h-10 text-red-600" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                </svg>
              </div>
              <h3 className="text-xl font-bold text-gray-800 mb-2">Navigator YouTube Channel</h3>
              <p className="text-gray-600 mb-6">
                4K flyovers of marinas across the Pacific Northwest
              </p>
              <a
                href="https://www.youtube.com/@navigatorpnw"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block bg-red-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-red-700 transition-colors"
              >
                Watch on YouTube
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Why Navigator */}
      <section className="py-16 bg-blue-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-gray-800 mb-4">Why Navigator?</h2>
          <p className="text-lg text-gray-600 mb-12 max-w-2xl mx-auto">
            As boaters ourselves, we are continually surprised at the lack of resources online for boaters. We are doing our part to fill that gap.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* Reliable Information */}
            <div className="text-center">
              <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="text-xl font-bold text-gray-800 mb-2">Reliable Information</h3>
              <p className="text-gray-600">
                Accurate, up-to-date information about fuel docks, marinas, and boating services.
              </p>
            </div>

            {/* Community Focused */}
            <div className="text-center">
              <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
              <h3 className="text-xl font-bold text-gray-800 mb-2">Community Focused</h3>
              <p className="text-gray-600">
                Built by boaters, for boaters. We understand your needs and challenges on the water.
              </p>
            </div>

            {/* Easy to Use */}
            <div className="text-center">
              <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              </div>
              <h3 className="text-xl font-bold text-gray-800 mb-2">Easy to Use</h3>
              <p className="text-gray-600">
                Simple, intuitive tools that work when you need them most, whether at the dock or on the water.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
